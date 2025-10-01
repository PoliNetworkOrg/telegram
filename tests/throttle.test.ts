import { describe, expect, it, vi } from "vitest"
import { throttle } from "@/utils/throttle"
import { wait } from "@/utils/wait"

async function callNTimes(n: number, ms: number, fn: () => void) {
  for (let i = 0; i < n; i++) {
    fn()
    await wait(ms)
  }
}

const testobj = {
  foo() {
    return 42
  },
}

describe("throttle function", () => {
  it("test 1", async () => {
    const spy = vi.spyOn(testobj, "foo")
    const limitms = 100
    const throttled = throttle(() => testobj.foo(), limitms)
    await callNTimes(11, 10, throttled)
    await wait(limitms + 20)
    expect(spy).toHaveBeenCalledTimes(3)
  })
  it("test 2", async () => {
    const spy = vi.spyOn(testobj, "foo")
    const limitms = 50
    const throttled = throttle(() => testobj.foo(), limitms)
    await callNTimes(3, 100, throttled)
    await wait(limitms + 20)
    expect(spy).toHaveBeenCalledTimes(3)
  })
  it("test 3", async () => {
    const spy = vi.spyOn(testobj, "foo")
    const limitms = 500
    const throttled = throttle(() => testobj.foo(), limitms)
    for (let i = 0; i < 50; i++) {
      throttled()
    }
    await wait(limitms + 20)
    expect(spy).toHaveBeenCalledTimes(2)
  })
  it("test 4", async () => {
    const spy = vi.spyOn(testobj, "foo")
    const limitms = 10
    const throttled = throttle(() => testobj.foo(), limitms)
    throttled()
    await wait(limitms + 20)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
