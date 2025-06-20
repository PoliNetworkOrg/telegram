import type { FlaggedCategory, ModerationCandidate, ModerationResult } from "./types"
import type { Context } from "@/lib/managed-commands"
import type { Filter, MiddlewareFn, MiddlewareObj } from "grammy"

import EventEmitter from "events"

import { Composer } from "grammy"
import OpenAI from "openai"

import { tgLogger } from "@/bot"
import { mute } from "@/lib/moderation"
import { logger } from "@/logger"
import { defer } from "@/utils/deferred-middleware"
import { duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { getText } from "@/utils/messages"
import { wait } from "@/utils/wait"

import { checkForAllowedLinks, parseFlaggedCategories } from "./functions"

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null

if (!client) logger.warn("Missing env OPENAI_API_KEY, automatic moderation will not work.")
else logger.debug("OpenAI client initialized for moderation.")

export class ModerationStack<C extends Context>
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

    this.composer.on(
      ["message::url", "message::text_link", "edited_message::url", "edited_message::text_link"],
      defer(async (ctx) => {
        const message = ctx.message ?? ctx.editedMessage
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

    this.composer.on(
      "message",
      defer(async (ctx) => {
        const message = ctx.message
        const flaggedCategories = await this.checkForHarmfulContent(ctx)
        const reasons = flaggedCategories
          .map((cat) => ` - ${cat.category} (${(cat.score * 100).toFixed(1)}%)`)
          .join("\n")

        if (flaggedCategories.some((cat) => cat.aboveThreshold)) {
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
          return
        }

        if (flaggedCategories.length > 0) {
          await tgLogger.autoModeration({
            action: "SILENT",
            target: ctx.from,
            message,
            reason: `Message flagged for moderation: \n${reasons}`,
          })
        }
      })
    )
  }

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
