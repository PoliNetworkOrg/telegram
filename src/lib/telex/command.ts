import type { Message } from "grammy/types"
import { Conversation, ConversationContext } from "./context"

interface RequiredArgumentOptions {
  key: string
  description?: string
  optional?: boolean
}
interface OptionalArgumentOptions extends RequiredArgumentOptions {
  optional: true
}
type ArgumentOptions = RequiredArgumentOptions | OptionalArgumentOptions
type ArgumentType<T extends ArgumentOptions> =
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
    context: ConversationContext
    conversation: Conversation
    args: ArgumentMap<A>
    repliedTo: RepliedTo<R>
  }) => Promise<void>
}
