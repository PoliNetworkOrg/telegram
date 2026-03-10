import type { Filter, MiddlewareObj } from "grammy"
import { Composer } from "grammy"
import type { Message } from "grammy/types"
import ssdeep from "ssdeep.js"
import { api } from "@/backend"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { redis } from "@/redis"
import { BotAttributes, botMetrics, withSpan } from "@/telemetry"
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
    await withSpan(
      "bot.automod.link_check",
      {
        [BotAttributes.IMPORTANCE]: "high",
        [BotAttributes.AUTOMOD_CHECK]: "link",
        [BotAttributes.CHAT_ID]: ctx.chat.id,
        [BotAttributes.USER_ID]: ctx.from.id,
      },
      async (span) => {
        const message = ctx.msg
        const links = ctx
          .entities("text_link")
          .map((e) => e.url)
          .concat([getText(message).text])

        const allowed = await checkForAllowedLinks(links)
        if (allowed) {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "pass")
          return
        }

        if (ctx.whitelisted) {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "whitelisted")
          if (ctx.whitelisted.role === "user") {
            await modules.get("tgLogger").grants({
              action: "USAGE",
              from: ctx.from,
              chat: ctx.chat,
              message,
            })
          }
          return
        }

        span.setAttribute(BotAttributes.AUTOMOD_RESULT, "fail")
        span.setAttribute(BotAttributes.AUTOMOD_ACTION, "mute")
        botMetrics.automodActions.add(1, {
          [BotAttributes.AUTOMOD_CHECK]: "link",
          [BotAttributes.AUTOMOD_ACTION]: "mute",
        })

        const res = await Moderation.mute(
          ctx.from,
          ctx.chat,
          ctx.me,
          duration.zod.parse("1m"),
          [message],
          "Shared link not allowed"
        )

        const msg = await ctx.reply(
          res.isOk()
            ? fmt(({ b }) => [
                b`${fmtUser(ctx.from)}`,
                "The link you shared is not allowed.",
                "Please refrain from sharing links that could be considered spam",
              ])
            : res.error.fmtError
        )
        await wait(5000)
        await msg.delete()
      }
    )
  }

  /**
   * Checks messages for harmful content using AI moderation.
   * If harmful content is detected, mutes the user and deletes the message.
   */
  private async harmfulContentHandler(ctx: Filter<ModerationContext<C>, "message">) {
    await withSpan(
      "bot.automod.harmful_content",
      {
        [BotAttributes.IMPORTANCE]: "high",
        [BotAttributes.AUTOMOD_CHECK]: "harmful_content",
        [BotAttributes.CHAT_ID]: ctx.chat.id,
        [BotAttributes.USER_ID]: ctx.from.id,
      },
      async (span) => {
        const message = ctx.message
        const flaggedCategories = await this.aiModeration.checkForHarmfulContent(ctx)

        if (flaggedCategories.length === 0) {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "pass")
          return
        }

        const reasons = flaggedCategories
          .map((cat) => ` - ${cat.category} (${(cat.score * 100).toFixed(1)}%)`)
          .join("\n")

        if (flaggedCategories.some((cat) => cat.aboveThreshold)) {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "fail")

          if (ctx.whitelisted) {
            span.setAttribute(BotAttributes.AUTOMOD_ACTION, "whitelisted")
            if (ctx.whitelisted.role === "user")
              await modules.get("tgLogger").grants({
                action: "USAGE",
                from: ctx.from,
                chat: ctx.chat,
                message,
              })
          } else {
            span.setAttribute(BotAttributes.AUTOMOD_ACTION, "mute")
            botMetrics.automodActions.add(1, {
              [BotAttributes.AUTOMOD_CHECK]: "harmful_content",
              [BotAttributes.AUTOMOD_ACTION]: "mute",
            })

            const res = await Moderation.mute(
              ctx.from,
              ctx.chat,
              ctx.me,
              duration.zod.parse("1d"),
              [message],
              `Automatic moderation detected harmful content\n${reasons}`
            )

            const msg = await ctx.reply(
              res.isOk()
                ? fmt(({ i, b }) => [
                    b`⚠️ Message from ${fmtUser(ctx.from)} was deleted automatically due to harmful content.`,
                    i`If you think this is a mistake, please contact the group administrators.`,
                  ])
                : res.error.fmtError
            )
            await wait(5000)
            await msg.delete()
          }
        } else {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "flagged_below_threshold")
          span.setAttribute(BotAttributes.AUTOMOD_ACTION, "silent_log")
          await modules.get("tgLogger").moderationAction({
            action: "SILENT",
            from: ctx.me,
            chat: ctx.chat,
            target: ctx.from,
            reason: `Message flagged for moderation: \n${reasons}`,
          })
        }
      }
    )
  }

  /**
   * Handles messages containing a high percentage of non-latin characters to avoid most spam bots.
   * If the percentage of non-latin characters is too high, mutes the user for 10 minutes and deletes the message.
   */
  private async nonLatinHandler(ctx: Filter<ModerationContext<C>, "message:text" | "message:caption">) {
    await withSpan(
      "bot.automod.non_latin",
      {
        [BotAttributes.IMPORTANCE]: "high",
        [BotAttributes.AUTOMOD_CHECK]: "non_latin",
        [BotAttributes.CHAT_ID]: ctx.chat.id,
        [BotAttributes.USER_ID]: ctx.from.id,
      },
      async (span) => {
        const text = ctx.message.caption ?? ctx.message.text
        const match = text.match(NON_LATIN.REGEX)

        if (match && (match.length - NON_LATIN.LENGTH_THR) / text.length > NON_LATIN.PERCENTAGE_THR) {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "fail")
          span.setAttribute(BotAttributes.AUTOMOD_ACTION, "mute")
          botMetrics.automodActions.add(1, {
            [BotAttributes.AUTOMOD_CHECK]: "non_latin",
            [BotAttributes.AUTOMOD_ACTION]: "mute",
          })

          const res = await Moderation.mute(
            ctx.from,
            ctx.chat,
            ctx.me,
            duration.zod.parse(NON_LATIN.MUTE_DURATION),
            [ctx.message],
            "Message contains non-latin characters"
          )
          if (res.isErr()) {
            logger.error(
              { from: ctx.from, chat: ctx.chat, messageId: ctx.message.message_id },
              "AUTOMOD: nonLatinHandler - Cannot mute"
            )
          }
        } else {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "pass")
        }
      }
    )
  }

  /**
   * Handles messages sent to multiple chats with similar content.
   */
  private async multichatSpamHandler(ctx: Filter<ModerationContext<C>, "message:text" | "message:media">) {
    if (ctx.from.is_bot || ctx.whitelisted) return

    await withSpan(
      "bot.automod.multichat_spam",
      {
        [BotAttributes.IMPORTANCE]: "high",
        [BotAttributes.AUTOMOD_CHECK]: "multichat_spam",
        [BotAttributes.CHAT_ID]: ctx.chat.id,
        [BotAttributes.USER_ID]: ctx.from.id,
      },
      async (span) => {
        const { text } = getText(ctx.message)
        if (text === null) {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "skip")
          return
        }
        if (text.length < MULTI_CHAT_SPAM.LENGTH_THR) {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "skip")
          return
        }
        const key = `moderation:multichatspam:${ctx.from.id}`
        const hash = ssdeep.digest(text)
        const res = await redis.rPush(key, `${hash}|${ctx.chat.id}|${ctx.message.message_id}`)
        await redis.expire(key, MULTI_CHAT_SPAM.EXPIRY)

        if (res >= 3) {
          const range = await redis.lRange(key, 0, -2)
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

          if (similarMessages.length === 0) {
            span.setAttribute(BotAttributes.AUTOMOD_RESULT, "pass")
            return
          }
          similarMessages.push(ctx.message)

          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "fail")
          span.setAttribute(BotAttributes.AUTOMOD_ACTION, "mute")
          botMetrics.automodActions.add(1, {
            [BotAttributes.AUTOMOD_CHECK]: "multichat_spam",
            [BotAttributes.AUTOMOD_ACTION]: "mute",
          })

          const muteDuration = duration.zod.parse(MULTI_CHAT_SPAM.MUTE_DURATION)
          const res = await Moderation.multiChatSpam(ctx.from, similarMessages, muteDuration)

          if (res.isErr()) {
            logger.error({ error: res.error }, "Cannot execute moderation action for MULTI_CHAT_SPAM")
          }
        } else {
          span.setAttribute(BotAttributes.AUTOMOD_RESULT, "pass")
        }
      }
    )
  }

  middleware() {
    return (this.composer as MiddlewareObj<C>).middleware()
  }
}
