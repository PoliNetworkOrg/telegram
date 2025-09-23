import { EventEmitter } from "node:events"
import type { Filter } from "grammy"
import OpenAI from "openai"
import { env } from "@/env"
import { logger } from "@/logger"
import { getText } from "@/utils/messages"
import type { Context } from "@/utils/types"
import { DELETION_THRESHOLDS } from "./constants"
import type { Category, FlaggedCategory, ModerationCandidate, ModerationResult } from "./types"

/**
 * # AI Moderation
 * ### *Look ma, I'm doing AI!*
 *
 * Uses OpenAI's free Moderation API to check messages for harmful content.
 *
 * Checks will be batched every 10 seconds to avoid hitting rate limits.
 * Checks both text and images (via URL) if present in the message.
 *
 * The bot will determine what to do with the results of the call based on
 * predefined thresholds. See {@link [DELETION_THRESHOLDS](./constants.ts)}
 *
 * More info on the API here: https://platform.openai.com/docs/guides/moderation
 */
export class AIModeration<C extends Context> extends EventEmitter<{
  results: [ModerationResult[]]
}> {
  /**
   * Takes each category, and for the flagged ones takes the score (highest among related results) and
   * confronts it with predefined thresholds
   *
   * @param results The array of results as provided by OpenAI's API
   * @returns An array of {@link FlaggedCategory} containing each category that was flagged by OpenAI
   */
  static parseFlaggedCategories(results: ModerationResult[]): FlaggedCategory[] {
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
      aboveThreshold: DELETION_THRESHOLDS[category] ? scores[category] >= DELETION_THRESHOLDS[category] : false,
    }))
  }

  private client: OpenAI | null
  private checkQueue: ModerationCandidate[] = []
  private timeout: NodeJS.Timeout | null = null

  constructor() {
    super()
    this.client = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null

    if (!this.client) logger.warn("[AI Mod] Missing env OPENAI_API_KEY, automatic moderation will not work.")
    else logger.debug("[AI Mod] OpenAI client initialized for moderation.")
  }

  /**
   * Triggers a moderation check for the queued messages.
   *
   * Called by a timeout after pushing an element in the queue
   */
  private triggerCheck() {
    if (!this.client) return
    if (this.checkQueue.length === 0) return

    const candidates = this.checkQueue.splice(0, this.checkQueue.length)

    void this.client.moderations
      .create({ input: candidates, model: "omni-moderation-latest" })
      .then((response) => {
        this.emit("results", response.results)
      })
      .catch((error: unknown) => {
        logger.error({ error }, "[AI Mod] Error during moderation check")
      })
  }

  /**
   * Wait for the moderation results to be emitted.
   *
   * This is done to allow batching of moderation checks.
   * @returns A promise that resolves with the moderation results, mapped as they were queued.
   */
  private waitForResults(): Promise<ModerationResult[]> {
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
  private addToCheckQueue(candidate: ModerationCandidate): Promise<ModerationResult | null> {
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
  async checkForHarmfulContent(context: Filter<C, "message">): Promise<FlaggedCategory[]> {
    if (!this.client) return []
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

    return AIModeration.parseFlaggedCategories(results)
  }
}
