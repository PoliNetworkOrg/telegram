import { describe, expect, it, vi } from "vitest"
import { throttleAsyncByKey } from "@/utils/throttle"

describe("throttleAsyncByKey", () => {
  it("coalesces updates independently for each key", async () => {
    vi.useFakeTimers()
    const calls: Array<[string, number]> = []
    const update = throttleAsyncByKey(
      async (jobId: string, progress: number) => {
        calls.push([jobId, progress])
      },
      (jobId) => jobId,
      5_000,
      vi.fn()
    )

    update("job-a", 1)
    update("job-a", 2)
    update("job-b", 10)
    update("job-b", 20)

    await vi.runAllTicks()
    expect(calls).toEqual([
      ["job-a", 1],
      ["job-b", 10],
    ])

    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toEqual([
      ["job-a", 1],
      ["job-b", 10],
      ["job-a", 2],
      ["job-b", 20],
    ])
    vi.useRealTimers()
  })

  it("does not start a newer update while the previous update is pending", async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const calls: number[] = []
    const update = throttleAsyncByKey(
      async (_jobId: string, progress: number) => {
        calls.push(progress)
        if (progress === 1)
          await new Promise<void>((resolve) => {
            release = resolve
          })
      },
      (jobId) => jobId,
      5_000,
      vi.fn()
    )

    update("job-a", 1)
    update("job-a", 2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toEqual([1])

    release?.()
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([1, 2])
    vi.useRealTimers()
  })
})
