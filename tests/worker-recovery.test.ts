import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runWorkerWithRecovery } from "@/utils/worker-recovery"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fixture() {
  return {
    run: vi.fn<() => Promise<void>>(),
    isRunning: vi.fn(() => false),
    isPaused: vi.fn(() => false),
    closing: undefined as Promise<void> | undefined,
  }
}

describe("worker recovery", () => {
  it("restarts a loop that stopped on a connection error and then processes work", async () => {
    const worker = fixture()
    const onError = vi.fn()
    const processed = vi.fn()
    const failure = new Error("Connection is closed")
    worker.run.mockRejectedValueOnce(failure).mockImplementationOnce(async () => processed())

    const task = runWorkerWithRecovery(worker, new AbortController().signal, onError)
    await vi.advanceTimersByTimeAsync(999)
    expect(processed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await task

    expect(onError).toHaveBeenCalledWith(failure)
    expect(processed).toHaveBeenCalledOnce()
    expect(worker.run).toHaveBeenCalledTimes(2)
  })

  it("cancels a pending restart when the module stops", async () => {
    const worker = fixture()
    const controller = new AbortController()
    worker.run.mockRejectedValueOnce(new Error("Connection is closed"))
    const task = runWorkerWithRecovery(worker, controller.signal, vi.fn())
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await task
    await vi.advanceTimersByTimeAsync(2000)
    expect(worker.run).toHaveBeenCalledOnce()
  })

  it.each(["paused", "closing", "running"])("does not restart a %s worker", async (state) => {
    const worker = fixture()
    if (state === "paused") worker.isPaused.mockReturnValue(true)
    if (state === "running") worker.isRunning.mockReturnValue(true)
    if (state === "closing") worker.closing = Promise.resolve()
    await runWorkerWithRecovery(worker, new AbortController().signal, vi.fn())
    expect(worker.run).not.toHaveBeenCalled()
  })

  it("does not restart after a deliberate pause following an error", async () => {
    const worker = fixture()
    worker.run.mockImplementationOnce(async () => {
      worker.isPaused.mockReturnValue(true)
      throw new Error("Connection is closed")
    })
    await runWorkerWithRecovery(worker, new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(2000)
    expect(worker.run).toHaveBeenCalledOnce()
  })
})
