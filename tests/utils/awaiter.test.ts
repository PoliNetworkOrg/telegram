import { describe, expect, it, vi } from "vitest"
import { Awaiter } from "@/utils/wait"

describe("Awaiter: PromiseLike implementation with manual resolution", () => {
  describe("basic resolution", () => {
    it("should resolve with a value", async () => {
      const awaiter = new Awaiter<string>()

      setTimeout(() => {
        awaiter.resolve("test value")
      }, 10)

      const result = await awaiter
      expect(result).toBe("test value")
    })

    it("should resolve with different types", async () => {
      const stringAwaiter = new Awaiter<string>()
      stringAwaiter.resolve("hello")
      expect(await stringAwaiter).toBe("hello")

      const numberAwaiter = new Awaiter<number>()
      numberAwaiter.resolve(42)
      expect(await numberAwaiter).toBe(42)

      const booleanAwaiter = new Awaiter<boolean>()
      booleanAwaiter.resolve(true)
      expect(await booleanAwaiter).toBe(true)

      const objectAwaiter = new Awaiter<{ id: number; name: string }>()
      objectAwaiter.resolve({ id: 1, name: "test" })
      expect(await objectAwaiter).toEqual({ id: 1, name: "test" })
    })

    it("should resolve with null and undefined", async () => {
      const nullAwaiter = new Awaiter<null>()
      nullAwaiter.resolve(null)
      expect(await nullAwaiter).toBe(null)

      const undefinedAwaiter = new Awaiter<undefined>()
      undefinedAwaiter.resolve(undefined)
      expect(await undefinedAwaiter).toBe(undefined)
    })
  })

  describe("instant resolution after already resolved", () => {
    it("should instantly resolve when awaited after resolution", async () => {
      const awaiter = new Awaiter<string>()
      awaiter.resolve("immediate")

      const start = Date.now()
      const result = await awaiter
      const elapsed = Date.now() - start

      expect(result).toBe("immediate")
      expect(elapsed).toBeLessThan(2) // Should be nearly instant
    })

    it("should always return the same value on multiple awaits", async () => {
      const awaiter = new Awaiter<string>()
      awaiter.resolve("same value")

      const result1 = await awaiter
      const result2 = await awaiter
      const result3 = await awaiter

      expect(result1).toBe("same value")
      expect(result2).toBe("same value")
      expect(result3).toBe("same value")
    })

    it("should handle rapid sequential awaits", async () => {
      const awaiter = new Awaiter<number>()
      awaiter.resolve(123)

      const results = await Promise.all([awaiter, awaiter, awaiter, awaiter, awaiter])

      expect(results).toEqual([123, 123, 123, 123, 123])
    })

    it("should work with concurrent awaits before resolution", async () => {
      const awaiter = new Awaiter<string>()

      const promise1 = awaiter
      const promise2 = awaiter
      const promise3 = awaiter

      // Resolve after promises are created but before awaited
      setTimeout(() => {
        awaiter.resolve("concurrent value")
      }, 10)

      const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3])

      expect(result1).toBe("concurrent value")
      expect(result2).toBe("concurrent value")
      expect(result3).toBe("concurrent value")
    })
  })

  describe("then() chaining", () => {
    it("should support then() method", async () => {
      const awaiter = new Awaiter<number>()
      awaiter.resolve(5)

      const result = await awaiter.then((value) => value * 2)
      expect(result).toBe(10)
    })

    it("should chain multiple then() calls", async () => {
      const awaiter = new Awaiter<number>()
      awaiter.resolve(2)

      const result = await awaiter
        .then((value) => value * 2)
        .then((value) => value + 3)
        .then((value) => value * 10)

      expect(result).toBe(70) // ((2 * 2) + 3) * 10
    })

    it("should handle then() with value transformation", async () => {
      const awaiter = new Awaiter<{ count: number }>()
      awaiter.resolve({ count: 5 })

      const result = await awaiter.then((obj) => obj.count.toString())
      expect(result).toBe("5")
    })

    it("should support then() that returns a promise", async () => {
      const awaiter = new Awaiter<string>()
      awaiter.resolve("hello")

      const result = await awaiter.then((value) => Promise.resolve(value.toUpperCase()))
      expect(result).toBe("HELLO")
    })

    it("should resolve then() instantly when awaiter is already resolved", async () => {
      const awaiter = new Awaiter<number>()
      awaiter.resolve(42)

      const start = Date.now()
      const result = await awaiter.then((value) => value * 2)
      const elapsed = Date.now() - start

      expect(result).toBe(84)
      expect(elapsed).toBeLessThan(2)
    })

    it("should handle null in then() callback", async () => {
      const awaiter = new Awaiter<string>()
      awaiter.resolve("value")

      const result = await awaiter.then(null)
      expect(result).toBe("value")
    })

    it("should handle undefined in then() callback", async () => {
      const awaiter = new Awaiter<string>()
      awaiter.resolve("value")

      const result = await awaiter.then(undefined)
      expect(result).toBe("value")
    })
  })

  describe("onrejected handler", () => {
    it("should support onrejected handler in then()", async () => {
      const awaiter = new Awaiter<string>()
      // Note: The current implementation doesn't have a reject method,
      // but we can test that onrejected handler is accepted
      awaiter.resolve("success")

      const result = await awaiter.then(
        (value) => value,
        () => "error handler"
      )
      expect(result).toBe("success")
    })
  })

  describe("promiselike integration", () => {
    it("should be usable with Promise.resolve()", async () => {
      const awaiter = new Awaiter<string>()
      awaiter.resolve("resolved")

      const result = await Promise.resolve(awaiter)
      expect(result).toBe("resolved")
    })

    it("should be usable with Promise.all()", async () => {
      const awaiter1 = new Awaiter<number>()
      const awaiter2 = new Awaiter<number>()

      awaiter1.resolve(1)
      awaiter2.resolve(2)

      const results = await Promise.all([awaiter1, awaiter2])
      expect(results).toEqual([1, 2])
    })

    it("should be usable with Promise.race()", async () => {
      const awaiter1 = new Awaiter<string>()
      const awaiter2 = new Awaiter<string>()

      awaiter1.resolve("first")
      // awaiter2 not resolved, so it loses the race

      const result = await Promise.race([awaiter1, awaiter2])
      expect(result).toBe("first")
    })

    it("should work in async/await context", async () => {
      const awaiter = new Awaiter<string>()

      const asyncFunction = async () => {
        const value = await awaiter
        return value.toUpperCase()
      }

      awaiter.resolve("hello")
      const result = await asyncFunction()
      expect(result).toBe("HELLO")
    })
  })

  describe("multiple resolves and timing", () => {
    it("should only use the first resolve call", async () => {
      const awaiter = new Awaiter<string>()

      awaiter.resolve("first")
      awaiter.resolve("second") // Should be ignored
      awaiter.resolve("third") // Should be ignored

      const result = await awaiter
      expect(result).toBe("first")
    })

    it("should handle delayed resolution followed by immediate awaits", async () => {
      const awaiter = new Awaiter<string>()

      setTimeout(() => {
        awaiter.resolve("delayed")
      }, 20)

      const promises = [
        awaiter,
        awaiter,
        (async () => {
          await new Promise((r) => setTimeout(r, 10))
          return awaiter
        })(),
      ]

      const results = await Promise.all(promises)
      expect(results[0]).toBe("delayed")
      expect(results[1]).toBe("delayed")
      expect(results[2]).toBe("delayed")
    })
  })

  describe("real-world use cases", () => {
    it("should work as a deferred value holder for async operations", async () => {
      const awaiter = new Awaiter<{ data: string }>()

      // Simulate an async operation that resolves the awaiter
      const asyncOp = async () => {
        await new Promise((r) => setTimeout(r, 20))
        awaiter.resolve({ data: "fetched" })
      }

      void asyncOp()

      // Multiple consumers can await the same value
      const [result1, result2] = await Promise.all([awaiter, awaiter])
      expect(result1).toEqual({ data: "fetched" })
      expect(result2).toEqual({ data: "fetched" })
    })

    it("should work with setTimeout async pattern", async () => {
      const awaiter = new Awaiter<number>()
      let counter = 0

      const interval = setInterval(() => {
        counter++
        if (counter >= 3) {
          clearInterval(interval)
          awaiter.resolve(counter)
        }
      }, 10)

      const result = await awaiter
      expect(result).toBe(3)
    })

    it("should integrate with event-like patterns", async () => {
      const awaiter = new Awaiter<string>()
      const events: string[] = []

      const listener = (event: string) => {
        events.push(event)
        if (event === "ready") {
          awaiter.resolve("listening complete")
        }
      }

      // Simulate event emission
      setTimeout(() => listener("start"), 5)
      setTimeout(() => listener("process"), 10)
      setTimeout(() => listener("ready"), 15)

      const result = await awaiter
      expect(result).toBe("listening complete")
      expect(events).toEqual(["start", "process", "ready"])
    })

    it("should handle multiple concurrent waiters on same awaiter", async () => {
      const awaiter = new Awaiter<string>()
      const callbacks = vi.fn()

      const waiter1 = awaiter.then((val) => {
        callbacks("waiter1")
        return val
      })

      const waiter2 = awaiter.then((val) => {
        callbacks("waiter2")
        return val
      })

      const waiter3 = awaiter.then((val) => {
        callbacks("waiter3")
        return val
      })

      awaiter.resolve("value")

      await Promise.all([waiter1, waiter2, waiter3])
      expect(callbacks).toHaveBeenCalledTimes(3)
      expect(callbacks).toHaveBeenCalledWith("waiter1")
      expect(callbacks).toHaveBeenCalledWith("waiter2")
      expect(callbacks).toHaveBeenCalledWith("waiter3")
    })
  })

  describe("edge cases", () => {
    it("should handle resolution with 0", async () => {
      const awaiter = new Awaiter<number>()
      awaiter.resolve(0)
      expect(await awaiter).toBe(0)
    })

    it("should handle resolution with empty string", async () => {
      const awaiter = new Awaiter<string>()
      awaiter.resolve("")
      expect(await awaiter).toBe("")
    })

    it("should handle resolution with empty array", async () => {
      const awaiter = new Awaiter<number[]>()
      awaiter.resolve([])
      expect(await awaiter).toEqual([])
    })

    it("should handle resolution with empty object", async () => {
      const awaiter = new Awaiter<Record<string, unknown>>()
      awaiter.resolve({})
      expect(await awaiter).toEqual({})
    })

    it("should preserve promise identity across multiple awaits", async () => {
      const awaiter = new Awaiter<string>()
      awaiter.resolve("value")

      const promise1 = awaiter.then((v) => v)
      const promise2 = awaiter.then((v) => v)

      const results = await Promise.all([promise1, promise2])
      expect(results[0]).toBe("value")
      expect(results[1]).toBe("value")
    })
  })
})
