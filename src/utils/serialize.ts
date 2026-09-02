/** Run asynchronous operations one at a time, in call order. */
export function serialize<A extends unknown[], R>(operation: (...args: A) => Promise<R>) {
  let tail: Promise<unknown> = Promise.resolve()

  return (...args: A): Promise<R> => {
    const result = tail.then(() => operation(...args))
    tail = result.catch(() => undefined)
    return result
  }
}
