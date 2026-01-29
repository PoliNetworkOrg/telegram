import type { Filter, MiddlewareObj } from "grammy"
import { Composer } from "grammy"
import type { Message } from "grammy/types"
import ssdeep from "ssdeep.js"
import { api } from "@/backend"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { redis } from "@/redis"
import { groupMessagesByChat, RestrictPermissions } from "@/utils/chat"
import { defer } from "@/utils/deferred-middleware"
import { duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { createFakeMessage, getText } from "@/utils/messages"
import { throttle } from "@/utils/throttle"
import type { Context } from "@/utils/types"
import { wait } from "@/utils/wait"
import { MessageUserStorage } from "../message-user-storage"
import { AIModeration } from "./ai-moderation"
import { MULTI_CHAT_SPAM, NON_LATIN } from "./constants"
import { checkForAllowedLinks } from "./functions"

export type WhitelistType = {
  role: "creator" | "admin" | "user"
}

type ModerationContext<C extends Context> = Filter<C, "message" | "edited_message"> & {
  whitelisted?: WhitelistType
}

const debouncedError = throttle((error: unknown, msg: string) => {
  logger.error({ error }, msg)
}, 1000 * 60)

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
  // the composer that holds all middlewares
  private composer = new Composer<ModerationContext<C>>()
  // AI moderation instance
  private aiModeration: AIModeration<C> = new AIModeration<C>()

  constructor() {
    this.composer
      .on(["message", "edited_message"])
      .fork() // fork the processing, this stack executes in parallel to the rest of the bot
      .filter(async (ctx) => {
        if (ctx.from.id === ctx.me.id) return false // skip messages from the bot itself
        const whitelistType = await this.isWhitelisted(ctx)
        if (whitelistType) {
          // creators can skip moderation entirely
          if (whitelistType.role === "creator") return false
          ctx.whitelisted = whitelistType
        }
        return true
      }) // skip if the message is whitelisted
      // register all middlewares
      .on(
        ["message::url", "message::text_link", "edited_message::url", "edited_message::text_link"],
        defer((ctx) => this.linkHandler(ctx))
      )
      .on(
        "message",
        defer((ctx) => this.harmfulContentHandler(ctx))
      )
      .on(
        ["message:text", "message:caption"],
        defer((ctx) => this.nonLatinHandler(ctx))
      )
      .on(
        ["message:text", "message:media"],
        defer((ctx) => this.multichatSpamHandler(ctx))
      )
  }

  /**
   * Checks if the message should be ignored by the moderation stack.
   *
   * TODO: implement a proper whitelist system
   * - [x] check if the user is privileged (admin, mod, etc)
   * - [x] check if the message is explicitly allowed by Direttivo (e.g. via a command)
   * - [ ] check if the chat allows specific types of content (?)
   *
   * @param ctx The context of the message
   * @returns WT {@link WhitelistType} if there is a whitelisted user, `null` otherwise
   */
  private async isWhitelisted(ctx: ModerationContext<C>): Promise<WhitelistType | null> {
    try {
      const { status } = await ctx.getAuthor()
      if (status === "creator") return { role: "creator" }
      if (status === "administrator") return { role: "admin" }

      const isAdmin = await api.tg.permissions.checkGroup.query({ userId: ctx.from.id, groupId: ctx.chatId })
      if (isAdmin) return { role: "admin" }

      const grant = await api.tg.grants.checkUser.query({ userId: ctx.from.id })
      if (grant.isGranted) return { role: "user" }
    } catch (e) {
      debouncedError(e, "Error checking whitelist status in auto-moderation")
    }

    return null
  }

  /**
   * Handles messages containing links.
   * If a link is not allowed, mutes the user for 1 minute and deletes the message.
   */
  private async linkHandler(
    ctx: Filter<
      ModerationContext<C>,
      "message::url" | "message::text_link" | "edited_message::url" | "edited_message::text_link"
    >
  ) {
    const message = ctx.msg
    // extract all links from the message, might be inside entities, or inside the message text body
    const links = ctx
      .entities("text_link")
      .map((e) => e.url)
      .concat([getText(message).text])

    const allowed = await checkForAllowedLinks(links)
    if (allowed) return

    if (ctx.whitelisted) {
      // no mod action
      if (ctx.whitelisted.role === "user") {
        // log the grant usage
        await modules.get("tgLogger").grants({
          action: "USAGE",
          from: ctx.from,
          chat: ctx.chat,
          message,
        })
      }
      return
    }

    await Moderation.mute({
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

  /**
   * Checks messages for harmful content using AI moderation.
   * If harmful content is detected, mutes the user and deletes the message.
   */
  private async harmfulContentHandler(ctx: Filter<ModerationContext<C>, "message">) {
    const message = ctx.message
    const flaggedCategories = await this.aiModeration.checkForHarmfulContent(ctx)

    if (flaggedCategories.length > 0) {
      const reasons = flaggedCategories.map((cat) => ` - ${cat.category} (${(cat.score * 100).toFixed(1)}%)`).join("\n")

      if (flaggedCategories.some((cat) => cat.aboveThreshold)) {
        if (ctx.whitelisted) {
          // log the action but do not mute
          if (ctx.whitelisted.role === "user")
            await modules.get("tgLogger").grants({
              action: "USAGE",
              from: ctx.from,
              chat: ctx.chat,
              message,
            })
        } else {
          // above threshold, mute user and delete the message
          await Moderation.mute({
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
        }
      } else {
        // no flagged category is above the threshold, still log it for manual review
        await modules.get("tgLogger").moderationAction({
          action: "SILENT",
          from: ctx.me,
          chat: ctx.chat,
          target: ctx.from,
          reason: `Message flagged for moderation: \n${reasons}`,
        })
      }
    }
  }

  /**
   * Handles messages containing a high percentage of non-latin characters to avoid most spam bots.
   * If the percentage of non-latin characters is too high, mutes the user for 10 minutes and deletes the message.
   */
  private async nonLatinHandler(ctx: Filter<ModerationContext<C>, "message:text" | "message:caption">) {
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
      await Moderation.mute({
        ctx,
        message: ctx.message,
        target: ctx.from,
        reason: "Message contains non-latin characters",
        duration: duration.zod.parse(NON_LATIN.MUTE_DURATION),
        from: ctx.me,
      })
    }
  }

  /**
   * Handles messages sent to multiple chats with similar content.
   */
  private async multichatSpamHandler(ctx: Filter<ModerationContext<C>, "message:text" | "message:media">) {
    if (ctx.from.is_bot || ctx.whitelisted) return
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
          .map(([hash, chatId, messageId]) => ({
            hash,
            chatId: Number(chatId),
            messageId: Number(messageId),
          }))
          .filter((v) => ssdeep.similarity(v.hash, hash) > MULTI_CHAT_SPAM.SIMILARITY_THR)
          .map(async (v) => {
            const msg = await MessageUserStorage.getInstance().get(v.chatId, v.messageId)
            const message = createFakeMessage(v.chatId, v.messageId, ctx.from, msg?.timestamp)
            return message
          })
      )

      if (similarMessages.length === 0) return
      similarMessages.push(ctx.message)

      const muteDuration = duration.zod.parse(MULTI_CHAT_SPAM.MUTE_DURATION)
      const tgLogger = modules.get("tgLogger")
      const preDeleteRes = await tgLogger.preDelete(similarMessages, "MultiChatSpam")

      // this one delete all similar messages and mutes the sender in all involved chat for `muteDuration`
      await Promise.allSettled(
        groupMessagesByChat(similarMessages)
          .entries()
          .flatMap(([chatId, mIds]) => [
            ctx.api.deleteMessages(chatId, mIds),
            ctx.api.restrictChatMember(chatId, ctx.from.id, RestrictPermissions.mute, {
              until_date: muteDuration.timestamp_s,
            }),
          ])
      )

      await tgLogger.moderationAction({
        action: "MULTI_CHAT_SPAM",
        from: ctx.me,
        chat: ctx.chat,
        preDeleteRes: preDeleteRes,
        messages: similarMessages,
        duration: muteDuration,
        target: ctx.from,
      })
    }
  }

  middleware() {
    return (this.composer as MiddlewareObj<C>).middleware()
  }
}
