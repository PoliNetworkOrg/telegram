/**
 * Throttles a function to limit the rate at which it can be called.
 *
 * The function will get called at most once every `limit` milliseconds.
 * If the function is called again before the `limit` has passed,
 * the call will be ignored, but a new call will be scheduled at the end of the
 * limit period, with the last arguments provided.
 *
 * @param func The function to throttle
 * @param limit The time limit in milliseconds
 * @returns A throttled version of the function
 */
export function throttle<A extends unknown[]>(func: (...args: A) => unknown, limit: number): (...args: A) => void {
  let timeout: NodeJS.Timeout | null = null
  let lastArgs: A
  let again: boolean = false

  return (...args: A): void => {
    lastArgs = args
    if (timeout === null) {
      // first call
      const handler = () => {
        if (again) {
          // if called again during the timeout, schedule another call
          timeout = setTimeout(handler, limit)
          func(...lastArgs)
        } else timeout = null // if not called again, clear the timeout
        again = false // reset the again flag
      }

      timeout = setTimeout(handler, limit)
      func(...args)
    } else again = true
  }
}

/**
 * Throttles calls independently for each key.
 *
 * A shared throttle lets a busy key replace the trailing call for every other
 * key. Keeping one small throttle state per active key preserves the latest
 * call for each key and removes that state once the key becomes idle.
 */
export function throttleAsyncByKey<A extends unknown[], K>(
  func: (...args: A) => Promise<void>,
  getKey: (...args: A) => K,
  limit: number,
  onError: (error: unknown, key: K) => void
): (...args: A) => void {
  type Entry = {
    lastArgs?: A
  }

  const entries = new Map<K, Entry>()

  const run = async (key: K, entry: Entry, args: A) => {
    const startedAt = Date.now()
    try {
      await func(...args)
    } catch (error) {
      onError(error, key)
    } finally {
      const remaining = Math.max(0, limit - (Date.now() - startedAt))
      setTimeout(() => {
        if (entry.lastArgs) {
          const nextArgs = entry.lastArgs
          entry.lastArgs = undefined
          void run(key, entry, nextArgs)
          return
        }

        entries.delete(key)
      }, remaining)
    }
  }

  return (...args: A): void => {
    const key = getKey(...args)
    const entry = entries.get(key)
    if (entry) {
      entry.lastArgs = args
      return
    }

    const newEntry: Entry = {}
    entries.set(key, newEntry)
    void run(key, newEntry, args)
  }
}
