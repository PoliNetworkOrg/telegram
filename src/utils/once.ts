import type { MaybePromise } from "./types"

/**
 * Wraps a function so that it can only be invoked once.
 *
 * On the first call, the wrapped function will execute normally and its
 * return value will be cached. On subsequent calls, the cached result will
 * be returned immediately without re-executing the function.
 *
 * This is useful for avoiding duplicate side effects, e.g. when initializing
 * services, registering event listeners, or performing expensive one-time
 * computations.
 *
 * @param fn - The function to be executed at most once
 * @returns A wrapped version of `fn` that only runs on the first call
 */
export function once<R, A extends unknown[]>(fn: (...args: A) => MaybePromise<R>) {
  let called = false
  let result: R

  return async (...args: A) => {
    if (!called) {
      called = true
      result = await fn(...args)
    }
    return result
  }
}
