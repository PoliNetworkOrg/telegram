import { describe, expect, it, vi } from "vitest"
import { singleFlight } from "@/utils/single-flight"

describe("singleFlight", () => {
  it("shares one in-flight operation and permits a new operation after it settles", async () => {
    let release: (() => void) | undefined
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const run = singleFlight(operation)

    const first = run()
    const second = run()
    expect(operation).toHaveBeenCalledTimes(1)

    release?.()
    await Promise.all([first, second])

    const third = run()
    expect(operation).toHaveBeenCalledTimes(2)
    release?.()
    await third
  })
})
