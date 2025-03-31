import type { Context } from "grammy"
import type { Message } from "grammy/types"
import type {
  Conversation as GConversation,
  ConversationFlavor,
} from "@grammyjs/conversations"
import type { HydrateFlavor } from "@grammyjs/hydrate"

export type Conversation = GConversation<
  ConversationFlavor<Context>,
  HydrateFlavor<Context>
>

export interface RequiredArgumentOptions {
  key: string
  description?: string
  optional?: boolean
}
export interface OptionalArgumentOptions extends RequiredArgumentOptions {
  optional: true
}
export type ArgumentOptions = RequiredArgumentOptions | OptionalArgumentOptions
export type ArgumentType<T extends ArgumentOptions> =
  T extends OptionalArgumentOptions ? string | undefined : string

export type CommandArgs = ReadonlyArray<ArgumentOptions>
export type RepliedTo<R extends CommandReplyTo> = R extends "required"
  ? Message
  : R extends "optional"
    ? Message | null
    : undefined
export type ArgumentMap<A extends CommandArgs = CommandArgs> = {
  [Entry in A[number] as Entry["key"]]: ArgumentType<Entry>
}
export type CommandReplyTo = "required" | "optional" | undefined

export interface Command<A extends CommandArgs, R extends CommandReplyTo> {
  trigger: string
  args?: A
  reply?: R
  description?: string
  handler: (cmd: {
    context: HydrateFlavor<Context>
    conversation: Conversation
    args: ArgumentMap<A>
    repliedTo: RepliedTo<R>
  }) => Promise<void>
}
