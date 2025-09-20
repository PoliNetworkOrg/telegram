import type { MiddlewareFn, MiddlewareObj } from "grammy"
import { Composer } from "grammy"
import type { Message } from "grammy/types"
import ssdeep from "ssdeep.js"
import { messageStorage, tgLogger } from "@/bot"
import type { Context } from "@/lib/managed-commands"
import { mute } from "@/lib/moderation"
import { redis } from "@/redis"
import { groupMessagesByChat, RestrictPermissions } from "@/utils/chat"
import { defer } from "@/utils/deferred-middleware"
import { duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { createFakeMessage, getText } from "@/utils/messages"
import { wait } from "@/utils/wait"
import { AIModeration } from "./ai-moderation"
import { MULTI_CHAT_SPAM, NON_LATIN } from "./constants"
import { checkForAllowedLinks } from "./functions"

/**
 * # Auto-Moderation stack
 * ## Handles automatic message moderation.
 *
 * This stack contains middlewares for various automatic message deletion policies.
 * Things like automatic URL detection, harmful content, spam, should all be handled here.
 *
 * ### current features:
 * - [x] Links handler
 * - [x] Harmful content handler
 * - [x] Multichat spam handler for similar messages
 * - [ ] Avoid deletion for messages explicitly allowed by Direttivo or from privileged users
 * - [x] handle non-latin characters
 */
export class AutoModerationStack<C extends Context> implements MiddlewareObj<C> {
  private composer = new Composer<C>()
  private aiModeration: AIModeration<C> = new AIModeration<C>()

  constructor() {
    // Links handler, deletes blacklisted domains
    this.composer.on(
      ["message::url", "message::text_link", "edited_message::url", "edited_message::text_link"],
      defer(async (ctx) => {
        // check both messages sent and edited
        const message = ctx.message ?? ctx.editedMessage
        // extract all links from the message, might be inside entities, or inside the message text body
        const links = ctx
          .entities("text_link")
          .map((e) => e.url)
          .concat([getText(message).text])
        const allowed = await checkForAllowedLinks(links)
        if (!allowed) {
          await mute({
            ctx,
            from: ctx.me,
            target: ctx.from,
            reason: "Shared link not allowed",
            duration: duration.zod.parse("1m"), // 1 minute
            message,
          })
          const msg = await ctx.reply(
            fmt(({ b }) => [
              b`${fmtUser(ctx.from)}`,
              "The link you shared is not allowed.",
              "Please refrain from sharing links that could be considered spam",
            ])
          )
          await wait(5000)
          await msg.delete()
          return
        }
      })
    )

    // Harmful content handler, mutes user if harmful content is detected (via OpenAI)
    this.composer.on(
      "message",
      defer(async (ctx) => {
        const message = ctx.message
        const flaggedCategories = await this.aiModeration.checkForHarmfulContent(ctx)

        if (flaggedCategories.length > 0) {
          const reasons = flaggedCategories
            .map((cat) => ` - ${cat.category} (${(cat.score * 100).toFixed(1)}%)`)
            .join("\n")

          if (flaggedCategories.some((cat) => cat.aboveThreshold)) {
            // above threshold, mute user and delete the message
            await mute({
              ctx,
              from: ctx.me,
              target: ctx.from,
              reason: `Automatic moderation detected harmful content\n${reasons}`,
              duration: duration.zod.parse("1d"), // 1 day
              message,
            })

            const msg = await ctx.reply(
              fmt(({ i, b }) => [
                b`⚠️ Message from ${fmtUser(ctx.from)} was deleted automatically due to harmful content.`,
                i`If you think this is a mistake, please contact the group administrators.`,
              ])
            )
            await wait(5000)
            await msg.delete()
          } else {
            // no flagged category is above the threshold, still log it for manual review
            await tgLogger.moderationAction({
              action: "SILENT",
              target: ctx.from,
              from: ctx.me,
              chat: ctx.chat,
              message,
              reason: `Message flagged for moderation: \n${reasons}`,
            })
          }
        }
      })
    )

    this.composer.on(
      ["message:text", "message:caption"],
      defer(async (ctx) => {
        const text = ctx.message.caption ?? ctx.message.text
        const match = text.match(NON_LATIN.REGEX)

        // 1. there are non latin characters
        // 2. there are more than LENGTH_THR non-latin characters
        // 3. the percentage of non-latin characters after the LENGTH_THR is more than PERCENTAGE_THR
        // that should catch messages respecting this inequality: 0.2y + 8 < x ≤ y
        // with x = number of non-latin characters, y = total length of the message
        // longer messages can have more non-latin characters, but less in percentage
        if (match && (match.length - NON_LATIN.LENGTH_THR) / text.length > NON_LATIN.PERCENTAGE_THR) {
          // just delete the message and mute the user for 10 minutes
          await mute({
            ctx,
            message: ctx.message,
            target: ctx.from,
            reason: "Message contains non-latin characters",
            duration: duration.zod.parse(NON_LATIN.MUTE_DURATION),
            from: ctx.me,
          })
        }
      })
    )

    // Multichat spam handler, mutes user if they send the same message in multiple chats
    this.composer.on(
      ["message:text", "message:media"],
      defer(async (ctx) => {
        if (ctx.from.is_bot) return
        const { text } = getText(ctx.message)
        if (text === null) return
        if (text.length < MULTI_CHAT_SPAM.LENGTH_THR) return // skip because too short
        const key = `moderation:multichatspam:${ctx.from.id}` // the key is unique for each user
        const hash = ssdeep.digest(text) // hash to compute message similarity
        const res = await redis.rPush(key, `${hash}|${ctx.chat.id}|${ctx.message.message_id}`) // push the message data to the redis list
        await redis.expire(key, MULTI_CHAT_SPAM.EXPIRY) // seconds expiry, refreshed with each message

        // triggered when more than 3 messages have been sent within EXPIRY seconds of each other
        if (res >= 3) {
          const range = await redis.lRange(key, 0, -2) // get all but the last
          const similarMessages: Message[] = await Promise.all(
            range
              .map((r) => r.split("|"))
              .map(([hash, chatId, messageId]) => ({ hash, chatId: Number(chatId), messageId: Number(messageId) }))
              .filter((v) => ssdeep.similarity(v.hash, hash) > MULTI_CHAT_SPAM.SIMILARITY_THR)
              .map(async (v) => {
                const msg = await messageStorage.get(v.chatId, v.messageId)
                const message = createFakeMessage(v.chatId, v.messageId, ctx.from, msg?.timestamp)
                return message
              })
          )

          if (similarMessages.length === 0) return
          similarMessages.push(ctx.message)

          const muteDuration = duration.zod.parse(MULTI_CHAT_SPAM.MUTE_DURATION)
          await Promise.allSettled(
            groupMessagesByChat(similarMessages)
              .keys()
              .map((chatId) =>
                ctx.api.restrictChatMember(chatId, ctx.from.id, RestrictPermissions.mute, {
                  until_date: muteDuration.timestamp_s,
                })
              )
          )

          await tgLogger.moderationAction({
            action: "MULTI_CHAT_SPAM",
            from: ctx.me,
            chat: ctx.chat,
            message: ctx.message,
            messages: similarMessages,
            duration: muteDuration,
            target: ctx.from,
          })
        }
      })
    )
  }

  middleware(): MiddlewareFn<C> {
    return this.composer.middleware()
  }
}
