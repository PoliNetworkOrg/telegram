import { setTimeout as delay } from "node:timers/promises"
import type { Worker } from "bullmq"

type RecoverableWorker = Pick<Worker, "run" | "isRunning" | "isPaused" | "closing">

/** Restart an unexpectedly failed worker loop; respect deliberate shutdown and pause. */
export async function runWorkerWithRecovery(
  worker: RecoverableWorker,
  signal: AbortSignal,
  onError: (error: unknown) => void
): Promise<void> {
  while (!signal.aborted && !worker.closing && !worker.isPaused() && !worker.isRunning()) {
    try {
      await worker.run()
      return
    } catch (error) {
      onError(error)
    }

    if (signal.aborted || worker.closing || worker.isPaused()) return
    try {
      await delay(1000, undefined, { signal })
    } catch (error) {
      if (signal.aborted) return
      throw error
    }
  }
}
