import { Bot, type Context } from "grammy"
import type {
  BotCommand,
  BotCommandScope,
  Chat,
  Message,
  MessageEntity,
  Update,
  User,
  UserFromGetMe,
} from "grammy/types"

/**
 * A fake Telegram to run the bot's middleware stack against simulated updates.
 *
 * It sits below grammY (as the `fetch` of the API client), so every API call is seen, including the ones made from
 * inside conversations, which build their own `Api` instances. It answers like Telegram would for the state it keeps:
 * chats, group admins and the commands menus, which it resolves per user exactly like Telegram does.
 *
 * @example
 * ```ts
 * const tg = new FakeTelegram()
 * const bot = await tg.createBot((bot) => bot.use(commands))
 * const alice = tg.user("Alice")
 * const group = tg.group("Test group")
 * tg.setAdmin(group, alice)
 *
 * const { replies } = await tg.send(bot, alice, "/help")
 * expect(tg.menuOf(alice, group).map((c) => c.command)).toContain("ban")
 * ```
 */

export type ApiCall = { method: string; payload: Record<string, unknown> }

/** A message sent by the bot during an exchange */
export type SentMessage = {
  chatId: number
  /** The text, without MarkdownV2 escapes and formatting */
  text: string
  /** The raw text as sent */
  raw: string
  /** The user who can see the message, if sent as an ephemeral message */
  ephemeralTo: number | null
}

/** What the bot did while handling one update */
export class Exchange {
  constructor(readonly calls: ApiCall[]) {}

  /** The calls to a specific API method */
  called(method: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  /** The messages the bot sent */
  get replies(): SentMessage[] {
    return this.called("sendMessage").map(({ payload }) => {
      const raw = String(payload.text ?? "")
      const ephemeral = payload.ephemeral_message_parameters as { receiver_user_id?: number } | undefined
      return {
        chatId: Number(payload.chat_id),
        raw,
        text: plain(raw),
        ephemeralTo: ephemeral?.receiver_user_id ?? null,
      }
    })
  }

  /** The text of the only message the bot sent, fails if it sent none or more than one */
  get reply(): string {
    const replies = this.replies
    if (replies.length !== 1)
      throw new Error(`expected exactly one reply, got ${replies.length}: ${JSON.stringify(replies)}`)
    return replies[0].text
  }
}

/** Removes MarkdownV2 escapes and formatting markers from a text */
export function plain(markdown: string): string {
  let out = ""
  for (let i = 0; i < markdown.length; i++) {
    const char = markdown[i]
    if (char === "\\") {
      out += markdown[++i] ?? ""
    } else if (!"*_~`|".includes(char)) {
      out += char
    }
  }
  return out
}

type Responder = (payload: Record<string, unknown>) => unknown

/** Thrown by a responder to make Telegram answer with an error */
export class FakeTelegramError extends Error {
  constructor(
    readonly description: string,
    readonly errorCode = 400
  ) {
    super(description)
  }
}

type GroupChat = Extract<Chat, { type: "supergroup" | "group" }>
type MemberStatus = "creator" | "administrator"

export class FakeTelegram {
  /** Every API call made by any bot attached to this fake, in order */
  readonly calls: ApiCall[] = []
  readonly me: UserFromGetMe = {
    id: 42,
    is_bot: true,
    first_name: "Test Bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  }

  private chats = new Map<number, Chat>()
  private admins = new Map<number, Map<number, MemberStatus>>()
  private menus = new Map<string, BotCommand[]>()
  private responders = new Map<string, Responder>()
  private nextId = 1000
  private nextUpdateId = 1
  private nextMessageId = 1

  /** The `fetch` implementation for grammY's API client */
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = url.slice(url.lastIndexOf("/") + 1)
    const body = init?.body
    const payload = typeof body === "string" && body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {}
    this.calls.push({ method, payload })

    try {
      const result = await this.respond(method, payload)
      return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } })
    } catch (error) {
      if (!(error instanceof FakeTelegramError)) throw error
      return new Response(JSON.stringify({ ok: false, error_code: error.errorCode, description: error.description }), {
        headers: { "content-type": "application/json" },
      })
    }
  }) as typeof fetch

  /** Creates a bot talking to this fake, `setup` installs its middleware */
  async createBot<C extends Context = Context>(setup?: (bot: Bot<C>) => void): Promise<Bot<C>> {
    const bot = new Bot<C>("123:TEST", { botInfo: this.me, client: { fetch: this.fetch } })
    setup?.(bot)
    await bot.init()
    return bot
  }

  /** Answers calls to an API method with a custom function, throw {@link FakeTelegramError} to fail the call */
  on(method: string, responder: Responder): this {
    this.responders.set(method, responder)
    return this
  }

  user(firstName: string, id: number = this.nextId++): User {
    return { id, is_bot: false, first_name: firstName }
  }

  group(title: string, id: number = -(1_000_000_000_000 + this.nextId++)): GroupChat {
    const chat: GroupChat = { id, type: "supergroup", title }
    this.chats.set(id, chat)
    return chat
  }

  privateChat(user: User): Chat {
    const chat: Chat = { id: user.id, type: "private", first_name: user.first_name }
    this.chats.set(chat.id, chat)
    return chat
  }

  /** Makes a user an admin (or the creator) of a group, as Telegram's getChatMember will report */
  setAdmin(group: Chat, user: User, status: MemberStatus = "administrator"): this {
    const admins = this.admins.get(group.id) ?? new Map<number, MemberStatus>()
    admins.set(user.id, status)
    this.admins.set(group.id, admins)
    return this
  }

  removeAdmin(group: Chat, user: User): this {
    this.admins.get(group.id)?.delete(user.id)
    return this
  }

  isAdmin(chatId: number, userId: number): boolean {
    return this.admins.get(chatId)?.has(userId) ?? false
  }

  /**
   * The commands menu the user sees in a chat (private chat by default), resolved like Telegram does:
   * https://core.telegram.org/bots/api#determining-list-of-commands
   */
  menuOf(user: User, chat?: Chat): BotCommand[] {
    const target = chat ?? this.privateChat(user)
    const scopes: BotCommandScope[] =
      target.type === "private"
        ? [{ type: "chat", chat_id: target.id }, { type: "all_private_chats" }, { type: "default" }]
        : [
            { type: "chat_member", chat_id: target.id, user_id: user.id },
            ...(this.isAdmin(target.id, user.id) ? [{ type: "chat_administrators", chat_id: target.id } as const] : []),
            { type: "chat", chat_id: target.id },
            ...(this.isAdmin(target.id, user.id) ? [{ type: "all_chat_administrators" } as const] : []),
            { type: "all_group_chats" },
            { type: "default" },
          ]
    for (const scope of scopes) {
      const menu = this.menus.get(scopeKey(scope))
      if (menu) return menu
    }
    return []
  }

  /** Just the command names of {@link FakeTelegram.menuOf} */
  menuCommandsOf(user: User, chat?: Chat): string[] {
    return this.menuOf(user, chat).map((c) => c.command)
  }

  /** A message update from `from`, in its private chat unless `options.chat` is given */
  messageUpdate(from: User, text: string, options: { chat?: Chat; replyTo?: Message } = {}): Update {
    const chat = options.chat ?? this.privateChat(from)
    this.chats.set(chat.id, chat)
    const entities: MessageEntity[] = []
    const command = /^\/[a-zA-Z0-9_]+(@[a-zA-Z0-9_]+)?/.exec(text)
    if (command) entities.push({ type: "bot_command", offset: 0, length: command[0].length })
    const message = {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat,
      from,
      text,
      ...(entities.length ? { entities } : {}),
      ...(options.replyTo ? { reply_to_message: options.replyTo } : {}),
    } as Message
    return { update_id: this.nextUpdateId++, message } as Update
  }

  /** A message to reply to in commands that require one */
  message(from: User, chat: Chat, text = "a message"): Message {
    return {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat,
      from,
      text,
    } as Message
  }

  /** Lets the bot handle an update, returns what it did */
  async handle<C extends Context>(bot: Bot<C>, update: Update): Promise<Exchange> {
    const start = this.calls.length
    await bot.handleUpdate(update)
    return new Exchange(this.calls.slice(start))
  }

  /** Sends a message from `from` to the bot, in its private chat unless `options.chat` is given */
  async send<C extends Context>(
    bot: Bot<C>,
    from: User,
    text: string,
    options: { chat?: Chat; replyTo?: Message } = {}
  ): Promise<Exchange> {
    return this.handle(bot, this.messageUpdate(from, text, options))
  }

  private async respond(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const responder = this.responders.get(method)
    if (responder) return responder(payload)

    switch (method) {
      case "getMe":
        return this.me
      case "sendMessage":
        return {
          message_id: this.nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: this.chatById(Number(payload.chat_id)),
          from: this.me,
          text: payload.text,
        }
      case "getChatMember": {
        const chatId = Number(payload.chat_id)
        const userId = Number(payload.user_id)
        const status = this.admins.get(chatId)?.get(userId) ?? "member"
        const user = { id: userId, is_bot: false, first_name: "User" }
        return status === "member" ? { status, user } : { status, user, is_anonymous: false }
      }
      case "setMyCommands":
        this.menus.set(scopeKey(payload.scope as BotCommandScope | undefined), payload.commands as BotCommand[])
        return true
      case "deleteMyCommands":
        this.menus.delete(scopeKey(payload.scope as BotCommandScope | undefined))
        return true
      case "getMyCommands":
        return this.menus.get(scopeKey(payload.scope as BotCommandScope | undefined)) ?? []
      default:
        return true
    }
  }

  private chatById(id: number): Chat {
    return (
      this.chats.get(id) ??
      (id > 0 ? { id, type: "private", first_name: "User" } : { id, type: "supergroup", title: "Group" })
    )
  }
}

function scopeKey(scope: BotCommandScope | undefined): string {
  const s = (scope ?? { type: "default" }) as { type: string; chat_id?: number | string; user_id?: number }
  return [s.type, s.chat_id ?? "", s.user_id ?? ""].join(":")
}
