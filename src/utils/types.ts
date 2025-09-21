import type { Context } from "grammy"

export type OptionalPropertyOf<T extends object> = Exclude<
  {
    [K in keyof T]: T[K] extends undefined ? never : K
  }[keyof T],
  undefined
>
export type ContextWith<P extends OptionalPropertyOf<Context>> = Exclude<Context, P> & {
  [K in P]: NonNullable<Context[P]>
}

export type MaybePromise<T> = T | Promise<T>
