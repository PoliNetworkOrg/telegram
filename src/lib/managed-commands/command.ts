import type { Message } from "grammy/types"
import type { Conversation, ConversationContext } from "./context"

interface RequiredArgumentOptions {
  key: string
  description?: string
  optional?: boolean
}
interface OptionalArgumentOptions extends RequiredArgumentOptions {
  optional: true
}
type ArgumentOptions = RequiredArgumentOptions | OptionalArgumentOptions
type ArgumentType<T extends ArgumentOptions> = T extends OptionalArgumentOptions ? string | undefined : string

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

export type CommandScope = "private" | "group" | "both"

interface PrivatePermissions<TRole extends string> {
  allowedRoles?: TRole[]
  excludedRoles?: TRole[]
}
interface GroupPermissions<TRole extends string> extends PrivatePermissions<TRole> {
  allowedGroupAdmins: boolean
  allowedGroupsId?: number[]
  excludedGroupsId?: number[]
}
type Permissions<TRole extends string, S extends CommandScope> = S extends "private"
  ? PrivatePermissions<TRole>
  : GroupPermissions<TRole>

export interface Command<
  A extends CommandArgs,
  R extends CommandReplyTo,
  S extends CommandScope,
  TRole extends string = string,
> {
  trigger: string
  scope?: S
  args?: A
  permissions?: Permissions<TRole, S>
  reply?: R
  description?: string
  handler: (cmd: {
    context: ConversationContext
    conversation: Conversation
    args: ArgumentMap<A>
    repliedTo: RepliedTo<R>
  }) => Promise<void>
}

export function isAllowedInGroups<A extends CommandArgs, R extends CommandReplyTo, TRole extends string = string>(
  cmd: Command<A, R, CommandScope, TRole>
): cmd is Command<A, R, "group" | "both", TRole> {
  return cmd.scope !== "private"
}

export function isAllowedInPrivateOnly<A extends CommandArgs, R extends CommandReplyTo, TRole extends string = string>(
  cmd: Command<A, R, CommandScope, TRole>
): cmd is Command<A, R, "private", TRole> {
  return cmd.scope === "private"
}
