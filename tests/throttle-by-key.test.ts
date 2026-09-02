import { describe, expect, it, vi } from "vitest"
import { throttleByKey } from "@/utils/throttle"

describe("throttleByKey", () => {
  it("coalesces updates independently instead of allowing one job to overwrite another", () => {
    vi.useFakeTimers()
    const calls: Array<[string, number]> = []
    const update = throttleByKey(
      (jobId: string, progress: number) => calls.push([jobId, progress]),
      (jobId) => jobId,
      5_000
    )

    update("job-a", 1)
    update("job-a", 2)
    update("job-b", 10)
    update("job-b", 20)

    expect(calls).toEqual([
      ["job-a", 1],
      ["job-b", 10],
    ])

    vi.advanceTimersByTime(5_000)
    expect(calls).toEqual([
      ["job-a", 1],
      ["job-b", 10],
      ["job-a", 2],
      ["job-b", 20],
    ])
    vi.useRealTimers()
  })
})
