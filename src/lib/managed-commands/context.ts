import type { ConversationFlavor } from "@grammyjs/conversations"
import type { HydrateFlavor } from "@grammyjs/hydrate"
import type { ParseModeFlavor } from "@grammyjs/parse-mode"
import type { ChatTypeContext, CommandContext, Context as TContext } from "grammy"
import type { Chat } from "grammy/types"

type OptionalPropertyOf<T extends object> = Exclude<
  {
    [K in keyof T]: T[K] extends undefined ? never : K
  }[keyof T],
  undefined
>

// NOTE: ParseModeFlavor must stay as the outer one
export type Context = ParseModeFlavor<HydrateFlavor<ConversationFlavor<TContext>>>
export type ConversationContext<CT extends Chat["type"]> = ChatTypeContext<
  CommandContext<ParseModeFlavor<HydrateFlavor<TContext>>>,
  CT
>
export type ContextWith<P extends OptionalPropertyOf<Context>> = Exclude<Context, P> & {
  [K in P]: NonNullable<Context[P]>
}
