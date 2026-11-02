import { describe, expect, it, vi } from "vitest"
import { serialize } from "@/utils/serialize"

describe("serialize", () => {
  it("runs every invocation in order without overlapping", async () => {
    const releases: Array<() => void> = []
    const started: string[] = []
    const operation = vi.fn(async (value: string) => {
      started.push(value)
      await new Promise<void>((resolve) => releases.push(resolve))
      return value
    })
    const run = serialize(operation)

    const first = run("first")
    const second = run("second")
    await vi.waitFor(() => expect(started).toEqual(["first"]))

    releases.shift()?.()
    await expect(first).resolves.toBe("first")
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]))

    releases.shift()?.()
    await expect(second).resolves.toBe("second")
  })

  it("continues after an invocation fails", async () => {
    const operation = vi.fn(async (value: string) => {
      if (value === "first") throw new Error("failed")
      return value
    })
    const run = serialize(operation)

    await expect(run("first")).rejects.toThrow("failed")
    await expect(run("second")).resolves.toBe("second")
  })
})
