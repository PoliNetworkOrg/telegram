import { api } from "@/backend"
import { InlineKeyboard } from "grammy"
import { Context } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { fmt } from "@/utils/format"

// --- Configuration ---
const LINK_REGEX = /https?:\/\/t\.me\/c\/(\d+)\/(\d+)/gi // Regex with global and case-insensitive flags
const TEXT_ROW_LIMIT = 4 // How many initial rows of text to include

type Config = {
  channelIds: number[]
  textRowsLimit?: number
}

// --- Middleware ---
export function messageLink({ channelIds, textRowsLimit = TEXT_ROW_LIMIT }: Config) {
  return async (ctx: Context) => {
    // Ensure it's a message and in a specified channel
    if (!ctx.message || !ctx.chat || !channelIds.includes(ctx.chat.id)) {
      return // Not a message or not in a target channel
    }

    const reporter = ctx.from?.username

    const messageText = ctx.message.text || ctx.message.caption
    if (!messageText) {
      return // No text or caption to scan
    }

    const matches = messageText.matchAll(LINK_REGEX)
    const processedLinks: { channelId: number; messageId: number }[] = [] // Track processed links to avoid duplicates

    for (const match of matches) {
      // Ensure we have capture groups
      if (!match[1] || !match[2]) {
        logger.warn(`Regex matched but missing capture groups: ${match}`)
        continue
      }

      const channelId = Number(match[1])
      const messageId = Number(match[2])

      // Skip if we've already processed this link in this message (e.g., multiple occurrences)
      if (processedLinks.some((link) => link.channelId === channelId && link.messageId === messageId)) {
        continue
      }
      processedLinks.push({ channelId, messageId })

      try {
        const { message, error } = await api.tg.messages.get.query({ chatId: channelId, messageId })
        if (error !== null) {
          if (error === "NOT_FOUND") {
            logger.warn(`messageLink: Message ${messageId} not found in channel ${channelId}`)
          }

          if (error === "DECRYPT_ERROR") {
            logger.error(
              `messageLink: there was an error in the backend while decrypting the message ${messageId}, channel ${channelId}`
            )
          }

          continue
        }

        const author = await ctx.api.getChatMember(message.chatId, message.authorId)
        if (!author) {
          logger.warn(`messageLink: cannot retrieve the author of the message ${messageId}, channel ${channelId}`)
          continue
        }
        const chat = await ctx.api.getChat(message.chatId)

        const inviteLink = chat.invite_link ?? (await api.tg.groups.getById.query({ telegramId: chat.id }))[0].link
        if (inviteLink === null) {
          logger.warn(`messageLink: chat ${chat.id} does not have invite link neither in telegram nor in the db`)
          continue
        }

        // 5. Construct the reply message text (using HTML for formatting)
        const messageCutted =
          message.message.length > 50 * textRowsLimit
            ? message.message.slice(50 * textRowsLimit).trimEnd() + " [...]"
            : message.message

        const response = fmt(
          ({ n, b, code, i }) => [
            b`Message link reported ${reporter ? `by @${reporter}` : ""}`,
            n`${b`Link:`} https://t.me/c/${channelId}/${messageId}`,
            n`${b`Author:`} @${author.user.username} [${code`${author.user.id}`}] ${author.status === "creator" || author.status === "administrator" ? b`ADMIN` : ``}`,
            n`${b`Group:`} ${chat.title} [${code`${chat.id}`}]`,
            n`${b`Timestamp:`} ${message.timestamp.toLocaleDateString("it")} ${message.timestamp.toLocaleTimeString("it")}`,
            b`\nContent:`,
            i`${messageCutted}`,
          ],
          { sep: "\n" }
        )

        // 6. Construct the buttons
        const inlineKeyboard = new InlineKeyboard()
        if (inviteLink) {
          inlineKeyboard.url("Join Group", inviteLink)
        }

        // 7. Send the reply message in the current chat
        await ctx.reply(response, {
          reply_markup: inlineKeyboard,
          link_preview_options: { is_disabled: true }, // Prevent previewing the invite link in the reply itself
        })
        await ctx.deleteMessage()
      } catch (error) {
        logger.error(`Error processing link t.me/c/${channelId}/${messageId}:`, error)
      }
    }
  }
}
