import { Cron } from "croner"
import type { Context } from "grammy"
import type { User } from "grammy/types"
import { type ApiInput, api } from "@/backend"
import { logger } from "@/logger"
import { type TelemetryContextFlavor, TrackedMiddleware } from "@/modules/telemetry"
import { padChatId } from "@/utils/chat"
import { serialize } from "@/utils/serialize"
import { toGrammyUser } from "@/utils/types"

export type Message = Parameters<typeof api.tg.messages.add.mutate>[0]["messages"][0]
type DBUsers = ApiInput["tg"]["users"]["add"]["users"]

type TC = TelemetryContextFlavor<Context>
export class MessageUserStorage<C extends TC> extends TrackedMiddleware<C> {
  private static instance: MessageUserStorage<TC> | null = null
  static getInstance<C extends TC>(): MessageUserStorage<C> {
    if (!MessageUserStorage.instance) {
      MessageUserStorage.instance = new MessageUserStorage<TC>()
    }
    return MessageUserStorage.instance as unknown as MessageUserStorage<C>
  }

  private memoryStorage: Message[] = []
  private userStorage: Map<number, User> = new Map()
  private flushMessages = serialize(async () => this.writeMessages())
  private flushUsers = serialize(async () => this.writeUsers())

  private async flushAll(): Promise<void> {
    const results = await Promise.allSettled([this.flushMessages(), this.flushUsers()])
    const failures = results.filter((result) => result.status === "rejected")
    if (failures.length === 1) throw failures[0].reason
    if (failures.length > 1) throw new AggregateError(failures.map((failure) => failure.reason))
  }

  private constructor() {
    super("message_user_storage")
    new Cron("0 */1 * * * *", () => {
      void this.sync().catch((error) => logger.error({ error }, "memoryStorage: Scheduled flush failed"))
    })

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

    // save user on join
    this.composer.on("chat_member").filter(
      (ctx) => ctx.chatMember.old_chat_member.status === "left" && ctx.chatMember.new_chat_member.status === "member",
      (ctx, next) => {
        this.userStorage.set(ctx.chatMember.new_chat_member.user.id, ctx.chatMember.new_chat_member.user)
        return next()
      }
    )
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
    await this.flushAll()
  }

  async syncMessages(): Promise<void> {
    await this.flushMessages()
  }

  private async writeMessages(): Promise<void> {
    if (this.memoryStorage.length === 0) return
    const messages = this.memoryStorage
    this.memoryStorage = []

    try {
      const { error } = await api.tg.messages.add.mutate({ messages })
      if (error) throw new Error(`Backend returned ${error}`)

      logger.debug(`memoryStorage: ${messages.length} messages written to the database`)
    } catch (error) {
      this.memoryStorage.unshift(...messages)
      logger.error({ error }, "memoryStorage: Failed to save messages in the backend")
      throw error
    }
  }

  public async getStoredUser(userId: number): Promise<User | null> {
    const fromMemory = this.userStorage.get(userId)
    if (fromMemory) return fromMemory

    try {
      const fromBackend = await api.tg.users.get.query({ userId })
      if (fromBackend.user) return toGrammyUser(fromBackend.user)

      if (fromBackend.error !== "NOT_FOUND")
        logger.error({ error: fromBackend.error }, "userStorage: error from API while retrieving user from backend")
    } catch (error) {
      logger.error({ error }, "userStorage: error while calling API for retrieving user from backend")
    }
    return null
  }

  private async writeUsers(): Promise<void> {
    if (this.userStorage.size === 0) return
    const pendingUsers = new Map(this.userStorage)
    const users: DBUsers = pendingUsers
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

    try {
      const { error } = await api.tg.users.add.mutate({ users })
      if (error) throw new Error(`Backend returned ${error}`)

      logger.debug(`userStorage: ${users.length} users upserted in the database`)
    } catch (error) {
      for (const [userId, user] of pendingUsers) {
        if (!this.userStorage.has(userId)) this.userStorage.set(userId, user)
      }
      logger.error({ error }, "userStorage: Failed to save users in the backend")
      throw error
    }
  }
}
