import { describe, expect, it, vi } from "vitest"
import { once } from "@/utils/once"

describe("once", () => {
  it("executes the wrapped function only once for sync results", async () => {
    const fn = vi.fn((value: number) => value * 2)
    const wrapped = once(fn)

    const first = await wrapped(2)
    const second = await wrapped(7)
    const third = await wrapped(11)

    expect(first).toBe(4)
    expect(second).toBe(4)
    expect(third).toBe(4)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(2)
  })

  it("returns the same promise for repeated async calls", async () => {
    const fn = vi.fn(async (name: string) => ({ name, createdAt: Date.now() }))
    const wrapped = once(fn)

    const promise1 = wrapped("first")
    const promise2 = wrapped("second")
    const promise3 = wrapped("third")

    expect(promise1).toBe(promise2)
    expect(promise2).toBe(promise3)

    const result1 = await promise1
    const result2 = await promise2
    const result3 = await promise3

    expect(result1).toEqual({ name: "first", createdAt: expect.any(Number) })
    expect(result2).toEqual(result1)
    expect(result3).toEqual(result1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith("first")
  })

  it("preserves the original rejection for later calls", async () => {
    const error = new Error("boom")
    const fn = vi.fn(async () => {
      throw error
    })
    const wrapped = once(fn)

    await expect(wrapped()).rejects.toThrow(error)
    // @ts-expect-error: This is testing that the same error is thrown on subsequent calls, even if the arguments are different
    await expect(wrapped("ignored")).rejects.toThrow(error)

    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("keeps the first resolved value even if later calls pass different arguments", async () => {
    const fn = vi.fn((value: string, suffix: string) => `${value}-${suffix}`)
    const wrapped = once(fn)

    await expect(wrapped("alpha", "one")).resolves.toBe("alpha-one")
    await expect(wrapped("beta", "two")).resolves.toBe("alpha-one")

    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith("alpha", "one")
  })
})
