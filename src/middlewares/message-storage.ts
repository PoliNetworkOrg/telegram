import { Cron } from "croner"
import type { MiddlewareFn } from "grammy"
import { api } from "@/backend"
import type { Context } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { padChatId } from "@/utils/chat"

export type Message = Parameters<typeof api.tg.messages.add.mutate>[0]["messages"][0]

export class MessageStorage {
  private memoryStorage: Message[]
  constructor() {
    this.memoryStorage = []
    new Cron("0 */1 * * * *", () => this.sync())
  }

  async get(chatId: number, messageId: number): Promise<Message | null> {
    const paddedChatId = padChatId(chatId)
    const memoryMsg = this.memoryStorage.find((m) => m.messageId === messageId && m.chatId === paddedChatId)
    if (memoryMsg) return memoryMsg

    const { error, message: dbMsg } = await api.tg.messages.get.query({ chatId: paddedChatId, messageId })
    if (!error) return dbMsg

    if (error === "DECRYPT_ERROR") {
      logger.error(
        `messageLink: there was an error in the backend while decrypting the message ${messageId} in chat ${chatId}`
      )
    }
    if (error === "NOT_FOUND") {
      logger.warn(`messageLink: Message ${messageId} not found in chat ${chatId}`)
    }
    return null
  }

  async sync(): Promise<void> {
    if (this.memoryStorage.length === 0) return
    const { error } = await api.tg.messages.add.mutate({ messages: this.memoryStorage })
    if (error) {
      logger.error(
        "memoryStorage: There was an error while encrypting messages in the backend, cannot save messages in table"
      )
      return
    }

    logger.debug(`memoryStorage: ${this.memoryStorage.length} messages written to the database`)
    this.memoryStorage = []
  }

  middleware: MiddlewareFn<Context> = (ctx, next) => {
    if (!ctx.from) {
      logger.debug("messageStorage skip: no ctx.from")
      return next()
    }
    if (!ctx.chatId || !ctx.chat) {
      logger.debug("messageStorage skip: no ctx.chatId")
      return next()
    }
    if (ctx.chat.type === "private") {
      logger.debug("messageStorage skip: chat type is private")
      return next()
    }
    if (!ctx.message) {
      logger.debug("messageStorage skip: no message")
      return next()
    }

    const text = ctx.message.text ?? ctx.message.caption
    this.memoryStorage.push({
      authorId: ctx.from.id,
      chatId: ctx.chatId,
      messageId: ctx.message.message_id,
      message: text ?? "[non-textual]",
      timestamp: new Date(ctx.message.date * 1000),
    })

    return next()
  }
}
