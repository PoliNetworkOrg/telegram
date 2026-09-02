import type { MiddlewareFn } from "grammy"
import { logger } from "@/logger"
import type { Context } from "@/utils/types"
import { wait } from "@/utils/wait"

export interface RaidBackpressureOptions {
  /** Time window in milliseconds to track update burst. Defaults to 2000ms. */
  windowMs?: number
  /** Maximum number of updates allowed per chat in the window before backpressure kicks in. Defaults to 20. */
  burstThreshold?: number
  /** Maximum allowed age in seconds for updates during a raid burst before shedding. Defaults to 60s. */
  maxStaleSeconds?: number
  /** Throttle delay in ms to apply to non-exempt updates when burst threshold is exceeded. Defaults to 50ms. */
  throttleDelayMs?: number
}

/**
 * Middleware that provides backpressure and rate limiting for update processing during raid bursts.
 *
 * During a raid, a massive influx of messages/events in a chat can overwhelm the bot,
 * triggering Telegram 429 rate limit storms and delaying callback queries past their 30s TTL.
 *
 * This middleware:
 * 1. Exempts callback queries completely so moderation buttons are never delayed or dropped.
 * 2. Tracks incoming update rate per chat.
 * 3. Sheds stale updates (>60s old) during raid bursts to prevent backlogged queues from consuming resources.
 * 4. Applies a brief backpressure throttle to smooth out incoming spikes and protect downstream Telegram API calls.
 */
export function raidBackpressure(options: RaidBackpressureOptions = {}): MiddlewareFn<Context> {
  const windowMs = options.windowMs ?? 2000
  const burstThreshold = options.burstThreshold ?? 20
  const maxStaleSeconds = options.maxStaleSeconds ?? 60
  const throttleDelayMs = options.throttleDelayMs ?? 50

  const chatUpdateTimestamps = new Map<number, number[]>()

  return async (ctx, next) => {
    // Callback queries must never be delayed or shed
    if (ctx.callbackQuery) {
      return next()
    }

    const chatId = ctx.chat?.id
    if (!chatId) {
      return next()
    }

    const now = Date.now()
    let timestamps = chatUpdateTimestamps.get(chatId)
    if (!timestamps) {
      timestamps = []
      chatUpdateTimestamps.set(chatId, timestamps)
    }

    // Clean up timestamps older than windowMs
    const cutoff = now - windowMs
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift()
    }

    timestamps.push(now)

    // Check if chat is currently experiencing a burst
    const isBursting = timestamps.length > burstThreshold

    if (isBursting) {
      // Check for stale updates during heavy burst
      const updateDate = ctx.msg?.date ?? ctx.chatMember?.date
      if (updateDate) {
        const ageSeconds = Math.floor(now / 1000) - updateDate
        if (ageSeconds > maxStaleSeconds) {
          logger.warn(
            { chatId, ageSeconds, updateId: ctx.update.update_id },
            "[RaidBackpressure] Shedding stale update during raid burst"
          )
          return
        }
      }

      logger.warn(
        { chatId, burstRate: timestamps.length, windowMs },
        "[RaidBackpressure] Applying backpressure throttle to chat during raid burst"
      )

      if (throttleDelayMs > 0) {
        await wait(throttleDelayMs)
      }
    }

    // Periodic cleanup of empty chat entries to avoid memory leak
    if (chatUpdateTimestamps.size > 1000) {
      for (const [id, ts] of chatUpdateTimestamps.entries()) {
        if (ts.length === 0 || ts[ts.length - 1] < cutoff) {
          chatUpdateTimestamps.delete(id)
        }
      }
    }

    return next()
  }
}
