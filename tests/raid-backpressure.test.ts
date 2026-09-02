import { describe, expect, it, vi } from "vitest"
import { raidBackpressure } from "@/middlewares/raid-backpressure"
import type { Context } from "@/utils/types"

describe("raidBackpressure middleware", () => {
  it("immediately allows callback queries without backpressure delay", async () => {
    const middleware = raidBackpressure({
      burstThreshold: 2,
      throttleDelayMs: 500,
    })

    const ctx = {
      callbackQuery: { id: "cb1" },
      chat: { id: -1001 },
      update: { update_id: 1 },
    } as unknown as Context

    const next = vi.fn().mockResolvedValue(undefined)
    const start = Date.now()
    await middleware(ctx, next)
    const duration = Date.now() - start

    expect(next).toHaveBeenCalledTimes(1)
    expect(duration).toBeLessThan(100)
  })

  it("sheds stale updates during a burst", async () => {
    const middleware = raidBackpressure({
      burstThreshold: 2,
      windowMs: 1000,
      maxStaleSeconds: 30,
    })

    const next = vi.fn().mockResolvedValue(undefined)
    const nowSec = Math.floor(Date.now() / 1000)

    // Send 2 updates within threshold
    for (let i = 0; i < 2; i++) {
      await middleware(
        {
          chat: { id: -1001 },
          msg: { date: nowSec },
          update: { update_id: i },
        } as unknown as Context,
        next
      )
    }
    expect(next).toHaveBeenCalledTimes(2)

    // Next update triggers burst threshold, but is fresh
    await middleware(
      {
        chat: { id: -1001 },
        msg: { date: nowSec },
        update: { update_id: 3 },
      } as unknown as Context,
      next
    )
    expect(next).toHaveBeenCalledTimes(3)

    // Next update is 60s stale during burst -> should be shed
    await middleware(
      {
        chat: { id: -1001 },
        msg: { date: nowSec - 60 },
        update: { update_id: 4 },
      } as unknown as Context,
      next
    )
    // next should not have been called for the stale update
    expect(next).toHaveBeenCalledTimes(3)
  })
})
