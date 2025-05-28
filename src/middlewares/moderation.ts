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

const POLINETWORK_DISCORD_GUILD_ID = "1286773946045300787"
const BANNED_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "bit.ly",
  "is.gd",
  "amzn.to",
  "goo.gl",
  "forms.gle",
  "docs.google.com",
  "amazon.it/gp/student",
  "amazon.com/gp/student",
  "polinetwork.it",
] as const

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  : null
if (!client) logger.warn("Missing env OPENAI_API_KEY, automatic moderation will not work.")
else logger.debug("OpenAI client initialized for moderation.")

type ModerationCandidate = OpenAI.Moderations.ModerationMultiModalInput
type ModerationResult = OpenAI.Moderations.Moderation

type Category = keyof OpenAI.Moderations.Moderation.CategoryScores
const deletionThreshold: Record<Category, number | false> = {
  harassment: false,
  "harassment/threatening": 0.9,
  hate: 0.9,
  "hate/threatening": 0.9,
  illicit: false,
  "illicit/violent": false,
  violence: 0.1,
  "violence/graphic": false,
  sexual: 0.9,
  "sexual/minors": 0.8,
  "self-harm": false,
  "self-harm/intent": false,
  "self-harm/instructions": false,
} as const

interface FlaggedCategory {
  category: Category
  score: number
  aboveThreshold: boolean
}

export class ModerationStack<C extends Context>
  extends EventEmitter<{
    results: [ModerationResult[]]
  }>
  implements MiddlewareObj<C>
{
  private composer = new Composer<C>()
  private lastCheck: number = 0
  private checkQueue: ModerationCandidate[] = []

  constructor() {
    super()

    this.composer.on(
      ["message::url", "message::text_link", "edited_message::url", "edited_message::text_link"],
      defer(async (ctx) => {
        const message = ctx.message ?? ctx.editedMessage
        const sender = ctx.from
        const links = ctx
          .entities("text_link")
          .map((e) => e.url)
          .concat([getText(message).text])
        const allowed = await this.checkForAllowedLinks(links)
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
              b`Message for ${ctx.from.username ? `@${ctx.from.username}` : fmtUser(sender)}`,
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
        const sender = ctx.from
        const message = ctx.message
        const flaggedCategories = await this.checkForHarmfulContent(ctx)
        const reasons = flaggedCategories.map((cat) => ` - ${cat.category} (${cat.score.toFixed(2)})`).join("\n")

        if (flaggedCategories.some((cat) => cat.aboveThreshold)) {
          await mute({
            ctx,
            from: ctx.me,
            target: ctx.from,
            reason: "Automatic moderation detected harmful content" + reasons,
            duration: duration.zod.parse("1d"), // 1 day
            message,
          })

          const msg = await ctx.reply(
            fmt(({ i }) => [
              `⚠️ Message from ${ctx.from.username ? `@${ctx.from.username}` : fmtUser(sender)} was deleted automatically due to harmful content.`,
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

  private async checkForAllowedLinks(links: string[]): Promise<boolean> {
    for (const url of links) {
      // these websites are simply not allowed
      if (BANNED_DOMAINS.some((domain) => url.includes(domain))) return false

      // specific discord invites handling
      const discordMatch = url.match(/discord\.gg\/([^/?#]+)/)
      if (discordMatch) {
        const code = discordMatch[1]
        const isPolinetworkDiscord = await fetch(`https://discordapp.com/api/invites/${code}`)
          .then((res) => res.json())
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          .then((v) => v?.guild?.id === POLINETWORK_DISCORD_GUILD_ID) // opt chaining, wont crash, and even if it did there's a catch clause
          .catch(() => false)
        if (!isPolinetworkDiscord) return false
      }

      // specific whatsapp invites handling
      const whatsappMatch = url.match(/.*whatsapp\.com\/([^/?#]+).*/)
      if (whatsappMatch) {
        const _code = whatsappMatch[1]
        // TODO: somehow manage to understand if the link is one of our groups???
        return false
      }

      // specific telegram invites handling
      const telegramMatch = url.match(/.*t\.me\/([^/?#]+).*/)
      if (telegramMatch) {
        const code = telegramMatch[1]
        if (code === "c") return true // this is the channel link, we allow it
        // TODO: fetch invite links from backend
        return false
      }
    }

    return true
  }

  private triggerCheck() {
    if (!client) return
    if (this.checkQueue.length === 0) return

    const candidates = this.checkQueue.splice(0, this.checkQueue.length)

    void client.moderations
      .create({ input: candidates, model: "omni-moderation-latest" })
      .then((response) => {
        const results = response.results
        this.emit("results", results)
      })
      .catch((error: unknown) => {
        logger.error({ error }, "Error during moderation check")
      })
  }

  private async waitForResults(): Promise<ModerationResult[]> {
    return new Promise((resolve) => {
      this.once("results", (results) => {
        resolve(results)
      })
    })
  }

  private async addToCheckQueue(candidate: ModerationCandidate): Promise<ModerationResult | null> {
    const index = this.checkQueue.push(candidate) - 1
    if (Date.now() - this.lastCheck > 1000 * 10) {
      this.lastCheck = Date.now()
      // throttle a check every 10 seconds
      setTimeout(() => {
        this.triggerCheck()
      }, 10) // small delay to allow other candidates to be added
    }
    return Promise.race([
      this.waitForResults().then((results) => {
        return results[index] ?? null
      }),
      wait(1000 * 30).then(() => {
        logger.warn("Moderation check timed out")
        return null
      }),
    ])
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
    const results = raw.filter((result) => result !== null)

    return this.parseFlaggedCategories(results)
  }

  private parseFlaggedCategories(results: ModerationResult[]): FlaggedCategory[] {
    const categories = new Set(
      results
        .map((result) => result.categories)
        .reduce<Category[]>((acc, curr) => {
          Object.keys(curr).forEach((key) => {
            const k = key as Category
            if (curr[k]) acc.push(k)
          })
          return acc
        }, [])
    )
    const scores = results
      .map((result) => result.category_scores)
      .reduce<Record<Category, number>>((acc, curr) => {
        Object.keys(curr).forEach((key) => {
          const k = key as Category
          acc[k] = Math.max(acc[k], curr[k])
        })
        return acc
      }, results[0].category_scores)
    return Array.from(categories).map((category) => ({
      category,
      score: scores[category],
      aboveThreshold: deletionThreshold[category] ? scores[category] >= deletionThreshold[category] : false,
    }))
  }

  middleware(): MiddlewareFn<C> {
    return this.composer.middleware()
  }
}
