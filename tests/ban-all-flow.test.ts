import { describe, expect, it } from "vitest"
import {
  assertBanAllQueueCapacity,
  BAN_ALL_QUEUE_CONFIG,
  BanAllQueueCapacityError,
  banAllFlowId,
  createBanAllFlow,
} from "@/modules/moderation/ban-all-flow"
import type { BanAll } from "@/modules/tg-logger/ban-all"

const banAll = {
  type: "BAN",
  target: 42,
  reporter: { id: 7 },
  state: { jobCount: 0, successCount: 0, failedCount: 0 },
} as BanAll

describe("BanAll flow", () => {
  it("waits for every child and applies retry and retention options to flow-created jobs", () => {
    const flow = createBanAllFlow(banAll, 99, [-1001, -1002])

    expect(flow.opts).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 86_400, count: 1_000 },
    })
    expect(flow.children).toHaveLength(2)

    for (const child of flow.children) {
      expect(child.opts).toMatchObject({
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        ignoreDependencyOnFailure: true,
        removeOnComplete: { age: 3_600, count: 50_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      })
      expect(child.opts).not.toHaveProperty("continueParentOnFailure")
    }
  })

  it("uses stable queue IDs when a caller supplies an idempotency key", () => {
    const first = createBanAllFlow(banAll, 99, [-1001, -1002], "campaign-operation")
    const retry = createBanAllFlow(banAll, 101, [-1001, -1002], "campaign-operation")

    expect(first.opts?.jobId).toBe(banAllFlowId("BAN", "campaign-operation"))
    expect(first.opts?.removeOnComplete).toEqual({ age: 2_592_000 })
    expect(retry.opts?.jobId).toBe(first.opts?.jobId)
    expect(retry.children.map((child) => child.opts?.jobId)).toEqual(first.children.map((child) => child.opts?.jobId))
  })

  it("bounds the executor rate while leaving headroom for explicit message deletion", () => {
    expect(BAN_ALL_QUEUE_CONFIG.EXECUTOR_RATE_LIMIT).toEqual({ max: 12, duration: 1_000 })
    expect(BAN_ALL_QUEUE_CONFIG.MAX_OUTSTANDING_EXECUTOR_JOBS).toBe(60_000)
  })

  it("rejects a flow that would exceed the outstanding-job cap", () => {
    const maximum = BAN_ALL_QUEUE_CONFIG.MAX_OUTSTANDING_EXECUTOR_JOBS

    expect(() => assertBanAllQueueCapacity(maximum - 652, 652)).not.toThrow()
    expect(() => assertBanAllQueueCapacity(maximum - 651, 652)).toThrow(BanAllQueueCapacityError)
  })
})
