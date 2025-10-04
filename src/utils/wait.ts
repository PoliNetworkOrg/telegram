/**
 * In a grammy conversation (e.g. in a command handler) you can't setTimeout an async method
 * and then return, because the conversation would exit and the method cannot be run.
 *
 * To avoid this error, you can use this method to wait for some delay and then execute the method
 * WARN: using high delays can increment the command handler complete time
 *
 * @param time_ms The time to be awaited in milliseconds
 * @returns A promise that resolves when the time is up
 */
export function wait(time_ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(() => {
      res()
    }, time_ms)
  })
}

/**
 * A utility class that implements PromiseLike<T> and allows manual resolution of the promise.
 * This is useful when you need to await a value that will be provided later, outside of the
 * current execution context.
 */
export class Awaiter<T> implements PromiseLike<T> {
  private promise: Promise<T>

  // biome-ignore lint/suspicious/noThenProperty: Literally needed to implement PromiseLike
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    // biome-ignore lint/suspicious/noExplicitAny: This is needed for the PromiseLike implementation
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): PromiseLike<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected)
  }

  private promiseResolve: (value: T) => void = () => {
    throw new Error("Promise not initialized. How did you even get here?")
  }

  constructor() {
    this.promise = new Promise<T>((res) => {
      this.promiseResolve = res
    })
  }

  public resolve(value: T): void {
    this.promiseResolve(value)
  }
}
