import { Cron } from "croner"
import { Composer, type Context, type MiddlewareObj } from "grammy"
import type { User } from "grammy/types"
import { type ApiInput, api } from "@/backend"
import { logger } from "@/logger"
import { padChatId } from "@/utils/chat"

export type Message = Parameters<typeof api.tg.messages.add.mutate>[0]["messages"][0]

export class MessageUserStorage<C extends Context> implements MiddlewareObj<C> {
  private static instance: MessageUserStorage<Context> | null = null
  static getInstance<C extends Context>(): MessageUserStorage<C> {
    if (!MessageUserStorage.instance) {
      MessageUserStorage.instance = new MessageUserStorage<Context>()
    }
    return MessageUserStorage.instance as unknown as MessageUserStorage<C>
  }

  private composer: Composer<C> = new Composer<C>()
  private memoryStorage: Message[] = []
  private userStorage: Map<number, User> = new Map()
  private constructor() {
    new Cron("0 */1 * * * *", () => this.sync())

    this.composer.on(["message:text", "message:caption"], (ctx, next) => {
      if (ctx.chat.type === "private") {
        logger.debug("messageStorage skip: chat type is private")
        return next()
      }

      const text = ctx.message.text ?? ctx.message.caption
      this.memoryStorage.push({
        authorId: ctx.from.id,
        chatId: ctx.chatId,
        messageId: ctx.message.message_id,
        message: text,
        timestamp: new Date(ctx.message.date * 1000),
      })

      this.userStorage.set(ctx.from.id, ctx.from)
      return next()
    })
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
    await Promise.all([this.syncMessages(), this.syncUsers()])
  }

  private async syncMessages(): Promise<void> {
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

  private async syncUsers(): Promise<void> {
    if (this.userStorage.size === 0) return
    const users: ApiInput["tg"]["users"]["add"]["users"] = this.userStorage
      .values()
      .toArray()
      .map((u) => ({
        id: u.id,
        firstName: u.first_name,
        lastName: u.last_name,
        username: u.username,
        isBot: u.is_bot,
        langCode: u.language_code,
      }))

    this.userStorage.clear()

    const { error } = await api.tg.users.add.mutate({ users })
    if (error === "ENCRYPT_ERROR") {
      logger.error("userStorage: There was an error while encrypting users in the backend, users voided")
      return
    } else if (error === "INTERNAL_SERVER_ERROR") {
      logger.error("userStorage: There was an UNEXPECTED error while saving users in backend, users voided")
      return
    }

    logger.debug(`userStorage: ${users.length} users upserted in the database`)
  }

  middleware() {
    return this.composer.middleware()
  }
}
