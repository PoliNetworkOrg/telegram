import type { NextFunction } from "grammy"
import { InlineKeyboard } from "grammy"
import { api } from "@/backend"
import { messageStorage } from "@/bot"
import type { Context } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { padChatId } from "@/utils/chat"
import { fmt, fmtChat } from "@/utils/format"

// --- Configuration ---
const LINK_REGEX = /https?:\/\/t\.me\/c\/(-?\d+)\/(\d+)(?:\/(\d+))?/gi // Regex with global and case-insensitive flags
const CHAR_LIMIT = 400 // How many initial rows of text to include

type Config = {
  channelIds: number[]
  textRowsLimit?: number
}

// --- Middleware ---
export function messageLink({ channelIds }: Config) {
  return async (ctx: Context, next: NextFunction) => {
    // Ensure it's a message and in a specified channel
    if (!ctx.message || !ctx.chat || !channelIds.includes(ctx.chat.id)) {
      return next() // Not a message or not in a target channel
    }

    const reporter = ctx.from?.username

    const messageText = ctx.message.text || ctx.message.caption
    if (!messageText) {
      return next() // No text or caption to scan
    }

    const matches = messageText.matchAll(LINK_REGEX)
    const processedLinks: { chatId: number; messageId: number }[] = [] // Track processed links to avoid duplicates

    for (const match of matches) {
      // Ensure we have capture groups
      if (!match[1] || !match[2]) {
        logger.warn(`Regex matched but missing capture groups: ${match.join(" - ")}`)
        continue
      }

      const chatId = Number(match[1])
      const messageId = match[3] ? Number(match[3]) : Number(match[2])

      // Skip if we've already processed this link in this message (e.g., multiple occurrences)
      if (processedLinks.some((link) => link.chatId === chatId && link.messageId === messageId)) {
        continue
      }
      processedLinks.push({ chatId, messageId })

      const { message, inviteLink } = await makeResponse(ctx, chatId, messageId, reporter)

      const inlineKeyboard = new InlineKeyboard()
      if (inviteLink) {
        inlineKeyboard.url("Join Group", inviteLink)
      }

      await ctx.reply(message, {
        reply_markup: inlineKeyboard,
        link_preview_options: { is_disabled: true }, // Prevent previewing the invite link in the reply itself
      })
      await ctx.deleteMessage()
    }

    return next()
  }
}

type Response = {
  message: string
  inviteLink?: string
}
async function makeResponse(
  ctx: Context,
  chatId: number,
  messageId: number,
  reporterUsername?: string
): Promise<Response> {
  const headerRes = fmt(
    ({ b, n }) => [
      b`Message link reported ${reporterUsername ? `by @${reporterUsername}` : ""}`,
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
  const inviteLink =
    chat.invite_link ?? (await api.tg.groups.getById.query({ telegramId: chat.id }))[0].link ?? undefined

  const message = await messageStorage.get(chatId, messageId)
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
    message.message.length > CHAR_LIMIT ? `${message.message.slice(50 * CHAR_LIMIT).trimEnd()} [...]` : message.message
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
  const authorRes = fmt(({ code, i, b, n }) =>
    author
      ? n`${b`Author:`} @${author.user.username} [${code`${author.user.id}`}] ${isAdmin && b`ADMIN`}`
      : n`${b`Author:`} ${i`not available`}`
  )

  return {
    message: fmt(({ skip }) => [skip`${headerRes}`, fmtChat(chat), skip`${authorRes}`, skip`${msgRes}`], {
      sep: "\n",
    }),
    inviteLink,
  }
}
