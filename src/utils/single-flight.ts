/** Share one in-flight invocation among concurrent callers. */
export function singleFlight<A extends unknown[], R>(operation: (...args: A) => Promise<R>) {
  let active: Promise<R> | undefined

  return (...args: A): Promise<R> => {
    if (active !== undefined) return active

    try {
      const current = operation(...args).finally(() => {
        if (active === current) active = undefined
      })
      active = current
      return current
    } catch (error) {
      return Promise.reject(error)
    }
  }
}
