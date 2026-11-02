import type { Context } from "grammy"
import { describe, expect, it } from "vitest"
import {
  AUTOMATIC_LOG_INTERVAL_MS,
  getUpdateConcurrencyKeys,
  IntervalGate,
  TELEGRAM_API_RETRY_OPTIONS,
} from "@/utils/bot-resilience"

function callbackContext(chatId: number, messageId: number, fromId = 42): Context {
  return {
    chat: { id: chatId },
    from: { id: fromId },
    callbackQuery: {
      message: { chat: { id: chatId }, message_id: messageId },
    },
  } as unknown as Context
}

describe("bot resilience", () => {
  it("does not serialize unrelated report callbacks behind the whole management chat", () => {
    const first = getUpdateConcurrencyKeys(callbackContext(-1001, 10))
    const second = getUpdateConcurrencyKeys(callbackContext(-1001, 11))

    expect(first).not.toEqual([])
    expect(first).not.toEqual(second)
    expect(first.filter((key) => second.includes(key))).toEqual([])
  })

  it("still serializes repeated presses on the same report", () => {
    const first = getUpdateConcurrencyKeys(callbackContext(-1001, 10, 42))
    const second = getUpdateConcurrencyKeys(callbackContext(-1001, 10, 99))

    expect(first).toEqual(second)
  })

  it("bounds Telegram retries so one API call cannot wait forever", () => {
    expect(TELEGRAM_API_RETRY_OPTIONS.maxDelaySeconds).toBeLessThanOrEqual(5)
    expect(TELEGRAM_API_RETRY_OPTIONS.maxRetryAttempts).toBeLessThanOrEqual(2)
    expect(TELEGRAM_API_RETRY_OPTIONS.rethrowHttpErrors).toBe(true)
  })

  it("paces noisy automatic audit logs and leaves capacity for moderation callbacks", () => {
    let now = 1_000
    const gate = new IntervalGate(AUTOMATIC_LOG_INTERVAL_MS, () => now)

    expect(gate.tryEnter()).toBe(true)
    expect(gate.tryEnter()).toBe(false)

    now += AUTOMATIC_LOG_INTERVAL_MS
    expect(gate.tryEnter()).toBe(true)
  })
})
