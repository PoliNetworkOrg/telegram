/**
 * Throttles a function to limit the rate at which it can be called.
 *
 * The function will get called at most once every `limit` milliseconds.
 * If the function is called again before the `limit` has passed,
 * the call will be ignored and the last result will be returned.
 *
 * @param func The function to throttle
 * @param limit The time limit in milliseconds
 * @returns A throttled version of the function
 */
export function throttle<A extends unknown[]>(func: (...args: A) => void, limit: number): (...args: A) => void {
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
