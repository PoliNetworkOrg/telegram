import { InlineKeyboard } from "grammy"
import type { User } from "grammy/types"
import { api } from "@/backend"
import { logger } from "@/logger"
import { TrackedMiddleware } from "@/modules/telemetry"
import { padChatId } from "@/utils/chat"
import { fmt, fmtChat, fmtUser } from "@/utils/format"
import { getText } from "@/utils/messages"
import type { Context } from "@/utils/types"
import { MessageUserStorage } from "./message-user-storage"

// --- Configuration ---
const LINK_REGEX = /https?:\/\/t\.me\/c\/(-?\d+)\/(\d+)(?:\/(\d+))?/gi // Regex with global and case-insensitive flags
const CHAR_LIMIT = 400 // How many initial rows of text to include

type Config = {
  chatIds: number[]
  textRowsLimit?: number
}

export class MessageLink<C extends Context> extends TrackedMiddleware<C> {
  constructor(config: Config) {
    super("message-link")

    this.composer
      .filter((ctx) => !!ctx.chatId && config.chatIds.includes(ctx.chatId))
      .on(["message:text", "message:caption"])
      .filter(
        (ctx) => getText(ctx.message).text.match(LINK_REGEX) !== null,
        async (ctx, next) => {
          logger.debug("[message-link] found a link to parse")

          const messageText = getText(ctx.message).text

          const matches = messageText.matchAll(LINK_REGEX)
          const processedLinks: { chatId: number; messageId: number }[] = [] // Track processed links to avoid duplicates

          for (const match of matches) {
            // Ensure we have capture groups
            if (!match[1] || !match[2]) {
              logger.warn(`[message-link] Regex matched but missing capture groups: ${match.join(" - ")}`)
              continue
            }

            const chatId = Number(match[1])
            const messageId = match[3] ? Number(match[3]) : Number(match[2])

            // Skip if we've already processed this link in this message (e.g., multiple occurrences)
            if (processedLinks.some((link) => link.chatId === chatId && link.messageId === messageId)) {
              continue
            }
            logger.info(
              { chatId, messageId, reporter: { username: ctx.from.username, id: ctx.from.id } },
              "[message-link] link parsed and sending response"
            )
            processedLinks.push({ chatId, messageId })

            const { message, inviteLink } = await makeResponse(ctx, chatId, messageId, ctx.from)

            const inlineKeyboard = new InlineKeyboard()
            if (inviteLink) {
              inlineKeyboard.url("Join Group", inviteLink)
            }

            await ctx.reply(message, {
              reply_markup: inlineKeyboard,
              link_preview_options: { is_disabled: true }, // Prevent previewing the invite link in the reply itself
              message_thread_id: ctx.chat.is_forum ? ctx.message.message_thread_id : undefined,
            })
            await ctx.deleteMessage()
          }

          return next()
        }
      )
  }
}

type Response = {
  message: string
  inviteLink?: string
}
async function makeResponse(ctx: Context, chatId: number, messageId: number, reporter: User): Promise<Response> {
  const headerRes = fmt(
    ({ b, n }) => [
      b`Message link reported`,
      n`${b`Reporter:`} ${fmtUser(reporter)}`,
      n`${b`Link:`} https://t.me/c/${chatId}/${messageId}`,
    ],
    { sep: "\n" }
  )

  const chat = await ctx.api.getChat(padChatId(chatId)).catch(() => null)
  if (chat === null) {
    logger.warn(`messageLink: cannot get details about chat ${chatId}, probably because the bot is not inside the chat`)
    return {
      message: fmt(
        ({ b, n, skip }) => [
          skip`${headerRes}`,
          n`\n${b`WARN:`} probably this is from a group not managed by PoliNetwork`,
        ],
        { sep: "\n" }
      ),
    }
  }

  const dbGroup = await api.tg.groups.getById.query({ telegramId: chat.id })
  const inviteLink = chat.invite_link ?? dbGroup?.link ?? undefined

  const message = await MessageUserStorage.getInstance().get(chatId, messageId)
  if (message === null) {
    return {
      message: fmt(
        ({ skip, i }) => [skip`${headerRes}`, fmtChat(chat, inviteLink), i`\nmessage details not available`],
        {
          sep: "\n",
        }
      ),
      inviteLink,
    }
  }

  const content =
    message.message.length > CHAR_LIMIT ? `${message.message.slice(0, CHAR_LIMIT).trimEnd()} [...]` : message.message
  const msgRes = fmt(
    ({ n, b, i }) => [
      n`${b`Timestamp:`} ${message.timestamp.toLocaleDateString("it")} ${message.timestamp.toLocaleTimeString("it", { hour: "2-digit", minute: "2-digit" })}`,
      b`\nContent:`,
      i`${content}`,
    ],
    { sep: "\n" }
  )

  const author = await ctx.api.getChatMember(chat.id, message.authorId).catch(() => null)
  if (author === null) {
    logger.warn(`messageLink: cannot get details about user ${message.authorId} in chat ${chatId}`)
  }

  const isAdmin = author?.status === "creator" || author?.status === "administrator"
  const authorRes = fmt(({ i, b, n }) =>
    author ? n`${b`Author:`} ${fmtUser(author.user)} ${isAdmin ? b`ADMIN` : ""}` : n`${b`Author:`} ${i`not available`}`
  )

  return {
    message: fmt(({ skip }) => [skip`${headerRes}`, fmtChat(chat), skip`${authorRes}`, skip`${msgRes}`], {
      sep: "\n",
    }),
    inviteLink,
  }
}
