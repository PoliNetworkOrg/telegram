import type { FlaggedCategory, ModerationCandidate, ModerationResult, MultiChatMsgCollection } from "./types"
import type { Context } from "@/lib/managed-commands"
import type { Filter, MiddlewareFn, MiddlewareObj } from "grammy"

import EventEmitter from "events"

import { Composer } from "grammy"
import OpenAI from "openai"
import ssdeep from "ssdeep.js"

import { messageStorage, tgLogger } from "@/bot"
import { mute } from "@/lib/moderation"
import { logger } from "@/logger"
import { redis } from "@/redis"
import { RestrictPermissions } from "@/utils/chat"
import { defer } from "@/utils/deferred-middleware"
import { duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { getText } from "@/utils/messages"
import { wait } from "@/utils/wait"

import { MULTI_CHAT_SPAM } from "./constants"
import { checkForAllowedLinks, parseFlaggedCategories } from "./functions"

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null

if (!client) logger.warn("Missing env OPENAI_API_KEY, automatic moderation will not work.")
else logger.debug("OpenAI client initialized for moderation.")

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
 * - [ ] handle non-latin characters
 */
export class AutoModerationStack<C extends Context>
  extends EventEmitter<{
    results: [ModerationResult[]]
  }>
  implements MiddlewareObj<C>
{
  private composer = new Composer<C>()
  private checkQueue: ModerationCandidate[] = []
  private timeout: NodeJS.Timeout | null = null

  constructor() {
    super()

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
            author: ctx.me,
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
        const flaggedCategories = await this.checkForHarmfulContent(ctx)

        if (flaggedCategories.length > 0) {
          const reasons = flaggedCategories
            .map((cat) => ` - ${cat.category} (${(cat.score * 100).toFixed(1)}%)`)
            .join("\n")

          if (flaggedCategories.some((cat) => cat.aboveThreshold)) {
            // above threshold, mute user and delete the message
            await mute({
              ctx,
              author: ctx.me,
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
            await tgLogger.autoModeration({
              action: "SILENT",
              target: ctx.from,
              message,
              reason: `Message flagged for moderation: \n${reasons}`,
            })
          }
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
          const similarMessages = await Promise.all(
            range
              .map((r) => r.split("|"))
              .map(([hash, chatId, messageId]) => ({ hash, chatId: Number(chatId), messageId: Number(messageId) }))
              .filter((v) => ssdeep.similarity(v.hash, hash) > MULTI_CHAT_SPAM.SIMILARITY_THR)
              .map(
                async (v) =>
                  (await messageStorage.get(v.chatId, v.messageId)) ?? { chatId: v.chatId, messageId: v.messageId }
              )
          )

          if (similarMessages.length === 0) return
          similarMessages.push({
            message: text,
            chatId: ctx.chat.id,
            authorId: ctx.from.id,
            messageId: ctx.message.message_id,
            timestamp: new Date(),
          })

          const chatsMap = new Map<number, number[]>()
          const chatsCollection = new Map<number, MultiChatMsgCollection>()
          similarMessages.forEach((msg) => {
            const ids = chatsMap.get(msg.chatId) ?? []
            ids.push(msg.messageId)
            chatsMap.set(msg.chatId, ids)

            const collection: MultiChatMsgCollection = chatsCollection.get(msg.chatId) ?? {
              chatId: msg.chatId,
              messages: [],
              unknownMessages: [],
            }

            if ("message" in msg) {
              collection.messages.push({ id: msg.messageId, message: msg.message, timestamp: msg.timestamp })
            } else collection.unknownMessages.push(msg.messageId)
            chatsCollection.set(msg.chatId, collection)
          })

          const muteDuration = duration.zod.parse(MULTI_CHAT_SPAM.MUTE_DURATION)
          await tgLogger.autoModeration({
            action: "MULTI_CHAT_SPAM",
            message: ctx.message,
            duration: muteDuration,
            chatCollections: Array.from(chatsCollection.values()),
            target: ctx.from,
            reason: "Multichat spam detected",
          })

          const deleted = await Promise.all(
            chatsMap.entries().map(async ([chatId, mIds]) => {
              await ctx.api.restrictChatMember(chatId, ctx.from.id, RestrictPermissions.mute, {
                until_date: muteDuration.timestamp_s,
              })
              return await ctx.api.deleteMessages(chatId, mIds).catch(() => false)
            })
          )

          logger.info(
            `Deleted messages from ${deleted.filter((v) => v).length}/${chatsMap.size} chats due to multichat spam. (${similarMessages.length} total messages)`
          )
        }
      })
    )
  }

  /**
   * Triggers a moderation check for the queued messages.
   *
   * Called by a timeout after pushing an element in the queue
   */
  private triggerCheck() {
    if (!client) return
    if (this.checkQueue.length === 0) return

    const candidates = this.checkQueue.splice(0, this.checkQueue.length)

    void client.moderations
      .create({ input: candidates, model: "omni-moderation-latest" })
      .then((response) => {
        this.emit("results", response.results)
      })
      .catch((error: unknown) => {
        logger.error({ error }, "Error during moderation check")
      })
  }

  /**
   * Wait for the moderation results to be emitted.
   *
   * This is done to allow batching of moderation checks.
   * @returns A promise that resolves with the moderation results, mapped as they were queued.
   */
  private async waitForResults(): Promise<ModerationResult[]> {
    return new Promise((resolve, reject) => {
      this.once("results", (results) => {
        resolve(results)
      })
      setTimeout(() => {
        reject(new Error("Moderation Check timed out"))
      }, 1000 * 30)
    })
  }

  /**
   * Add a candidate to the moderation check queue, returns the result if found.
   * @param candidate the candidate to add to the queue, either text or image
   * @returns A promise that resolves with the moderation result, or null if not found or timed out.
   */
  private async addToCheckQueue(candidate: ModerationCandidate): Promise<ModerationResult | null> {
    const index = this.checkQueue.push(candidate) - 1
    if (this.timeout === null) {
      // throttle a check every 10 seconds
      this.timeout = setTimeout(() => {
        this.triggerCheck()
        this.timeout = null
      }, 10 * 1000)
    }
    return this.waitForResults()
      .then((results) => results[index] ?? null)
      .catch(() => null) // check timed out
  }

  /**
   * Check for harmful content in the message context.
   * @param context the message context to check
   * @returns A list of flagged categories found in the message
   */
  private async checkForHarmfulContent(context: Filter<C, "message">): Promise<FlaggedCategory[]> {
    if (!client) return []
    const candidates: ModerationCandidate[] = []
    const { text } = getText(context.message)
    if (text) candidates.push({ text, type: "text" })
    if (context.message.photo) {
      const photo = context.message.photo[0]
      const file = await context.api.getFile(photo.file_id)
      const url = `https://api.telegram.org/file/bot${context.api.token}/${file.file_path}`

      candidates.push({ image_url: { url }, type: "image_url" })
    }

    const raw = await Promise.all(candidates.map((candidate) => this.addToCheckQueue(candidate)))
    const results = raw.filter((result) => result !== null) // fail open, e.g check times out: leave the message be

    return parseFlaggedCategories(results)
  }

  middleware(): MiddlewareFn<C> {
    return this.composer.middleware()
  }
}
