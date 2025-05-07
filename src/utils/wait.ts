/**
 * In a grammy conversation (e.g. in a command handler) you can't setTimeout an async method
 * and then return, because the conversation would exit and the method cannot be run.
 *
 * To avoid this error, you can use this method to wait for some delay and then execute the method
 * WARN: using high delays can increment the command handler complete time
 */
export function wait(time_ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(() => {
      res()
    }, time_ms)
  })
}
