/**
 * In a grammy conversation (e.g. in a command handler) you can't setTimeout an async method
 * and then return, because the conversation would exit and the method cannot be run.
 *
 * To avoid this error, you can use this method which wait for the setTimeout body to complete, before exiting the conversation.
 * WARN: using high delays can increment the command handler complete time
 */
export function asyncDelay<T>(cb: () => Promise<T>, delay: number): Promise<T> {
  return new Promise((res) => {
    setTimeout(() => {
      cb()
        .then((v) => {
          res(v)
        })
        .catch((e: unknown) => {
          throw e
        })
    }, delay)
  })
}
