import type { Context as TContext } from "grammy"
import type { ManagedCommandsFlavor } from "@/lib/managed-commands"

export type OptionalPropertyOf<T extends object> = Exclude<
  {
    [K in keyof T]: T[K] extends undefined ? never : K
  }[keyof T],
  undefined
>
export type ContextWith<P extends OptionalPropertyOf<TContext>> = Exclude<TContext, P> & {
  [K in P]: NonNullable<TContext[P]>
}

export type MaybePromise<T> = T | Promise<T>

export type Context = ManagedCommandsFlavor<TContext>
