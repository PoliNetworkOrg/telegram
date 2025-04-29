import { Context } from "@/lib/managed-commands"
import { MiddlewareFn } from "grammy"
import { api } from "@/backend"
import { Cron } from "croner"
import { logger } from "@/logger"

type Message = Parameters<typeof api.tg.messages.add.mutate>[0]["messages"][0]

let tempStorage: Message[] = []

export const messageStorage: MiddlewareFn<Context> = async (ctx, next) => {
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
  if (!text) {
    logger.debug("messageStorage skip: no message text")
    return next()
  }

  tempStorage.push({
    authorId: ctx.from.id,
    chatId: ctx.chatId,
    messageId: ctx.message.message_id,
    message: text,
    timestamp: new Date(ctx.message.date * 1000),
  })

  next()
}

new Cron("0 */1 * * * *", async () => {
  if (tempStorage.length === 0) return
  const { error } = await api.tg.messages.add.mutate({ messages: tempStorage })
  if (error === "ENCRYPT_ERROR")
    logger.error(
      "memoryStorage: There was an error while encrypting messages in the backend, cannot save messages in table"
    )
  else if (!error) {
    logger.debug(`memoryStorage: ${tempStorage.length} messages written to the database`)
    tempStorage = []
  }
})
