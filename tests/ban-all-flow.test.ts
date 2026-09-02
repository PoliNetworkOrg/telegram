import { describe, expect, it } from "vitest"
import { createBanAllFlow } from "@/modules/moderation/ban-all-flow"
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
})
