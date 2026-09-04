import type { AutoRetryOptions } from "@grammyjs/auto-retry"
import type { Context } from "grammy"

export const AUTOMATIC_LOG_INTERVAL_MS = 15_000

export const TELEGRAM_API_RETRY_OPTIONS = {
  // The plugin sleeps before checking its retry counter. One retry at the
  // longest accepted delay keeps an interactive request below Telegram's
  // callback-query deadline.
  maxDelaySeconds: 3,
  maxRetryAttempts: 1,
  rethrowHttpErrors: true,
  rethrowInternalServerErrors: true,
} satisfies AutoRetryOptions

/** A non-blocking fixed-interval gate for best-effort operations. */
export class IntervalGate {
  private nextAllowedAt = 0

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now
  ) {}

  tryEnter(): boolean {
    const now = this.now()
    if (now < this.nextAllowedAt) return false

    this.nextAllowedAt = now + this.intervalMs
    return true
  }
}

/**
 * Keep ordering where updates can mutate the same state without making one
 * slow report action block every callback in the management chat.
 */
export function getUpdateConcurrencyKeys(ctx: Context): string[] {
  const callbackMessage = ctx.callbackQuery?.message
  if (callbackMessage) return [`callback:${callbackMessage.chat.id}:${callbackMessage.message_id}`]

  if (ctx.callbackQuery) return ctx.from ? [`callback-user:${ctx.from.id}`] : []

  return [ctx.chat ? `chat:${ctx.chat.id}` : undefined, ctx.from ? `user:${ctx.from.id}` : undefined].filter(
    (key): key is string => key !== undefined
  )
}
