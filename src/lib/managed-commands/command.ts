import type { Conversation } from "@grammyjs/conversations"
import type { Context } from "grammy"
import type { BotCommand, Message } from "grammy/types"
import type { z } from "zod"
import type { MaybeArray } from "@/utils/types"
import type { ConversationContext } from "./context"

interface BaseArgumentOptions {
  key: string
  description?: string
  optional?: boolean
}

interface TypedArgumentOptions<Out = unknown> extends BaseArgumentOptions {
  type: z.ZodType<Out, string>
}

type RequiredArgumentOptions = BaseArgumentOptions | TypedArgumentOptions
type OptionalArgumentOptions = RequiredArgumentOptions & {
  optional: true
}

export type ArgumentOptions = RequiredArgumentOptions | OptionalArgumentOptions
export type ArgumentType<Out, T extends ArgumentOptions> = T extends OptionalArgumentOptions ? Out | undefined : Out

export function isTypedArgumentOptions(opts: ArgumentOptions): opts is TypedArgumentOptions {
  return "type" in opts
}

export type CommandArgs = ReadonlyArray<ArgumentOptions>
export type RepliedTo<R extends CommandReplyTo> = R extends "required"
  ? Message
  : R extends "optional"
    ? Message | null
    : undefined
export type ArgumentMap<A extends CommandArgs = CommandArgs> = {
  [Entry in A[number] as Entry["key"]]: ArgumentType<
    Entry extends TypedArgumentOptions ? z.output<Entry["type"]> : string,
    Entry
  >
}
export type CommandReplyTo = "required" | "optional" | undefined

export type CommandScope = "private" | "group" | "both"

interface PrivatePermissions<TRole extends string> {
  /** The roles that are allowed to use the command */
  allowedRoles?: TRole[]
  /** The roles that are excluded from using the command */
  excludedRoles?: TRole[]
}
interface GroupPermissions<TRole extends string> extends PrivatePermissions<TRole> {
  /**
   * Whether to allow group admins to use the command, without considering their external role
   *
   * You can use hooks to override what is considered a group admin, by default it considers users with
   * Telegram Chat Role of "administrator" or "creator" as group admins
   */
  allowGroupAdmins: boolean
  /** Group IDs where the command is allowed */
  allowedGroupsId?: number[]
  /** Group IDs where the command is not allowed, if a group ID is in both allowedGroupsId and excludedGroupsId, the exclusion takes precedence */
  excludedGroupsId?: number[]
}
type Permissions<TRole extends string, S extends CommandScope> = S extends "private"
  ? PrivatePermissions<TRole>
  : GroupPermissions<TRole>

export type CommandScopedContext<
  S extends CommandScope = CommandScope,
  C extends Context = Context,
> = S extends "private"
  ? ConversationContext<"private", C>
  : S extends "group"
    ? ConversationContext<"group", C> | ConversationContext<"supergroup", C>
    : ConversationContext<"private", C> | ConversationContext<"group", C> | ConversationContext<"supergroup", C>

export type CommandConversation<S extends CommandScope = CommandScope, C extends Context = Context> = Conversation<
  C,
  CommandScopedContext<S, C>
>

/**
 * Represents a command that can be registered in the ManagedCommands collection.
 *
 * @template A The type of the command arguments, this should be an array of {@link ArgumentOptions}
 * @template R The type of the command reply, this should be "required", "optional" or undefined
 * @template S The scope of the command, this should be "private", "group" or "both"
 * @template TRole The type of the roles used in permissions, this should be a string literal type representing the possible roles in the bot (e.g. "admin" | "moderator" | "user")
 */
export interface Command<
  A extends CommandArgs,
  R extends CommandReplyTo,
  S extends CommandScope,
  TRole extends string = string,
  C extends Context = Context,
> {
  /**
   * The command trigger, the string that will be used to call the command.
   * If an array is provided, all entries will be used as aliases for the command
   */
  trigger: MaybeArray<string>
  /**
   * The scope of the command, can be "private", "group" or "both".
   * @default "both"
   */
  scope?: S
  /**
   * The arguments that the command accepts, each argument is an object with a key and a type.
   * In the handler, the arguments will be available as an object with the keys as the argument keys. (optionally undefined if not required)
   */
  args?: A
  /**
   * The permissions required to use the command, you can either allow or exclude specific roles.
   *
   * If the command is allowed in groups, you can also allow or exclude specific group IDs and whether or not to consider permissions for group admins.
   */
  permissions?: Permissions<TRole, S>
  /**
   * The type of reply that the command accepts, can be "required", "optional" or undefined.
   * If the command accepts a reply, it will be available in the handler as `repliedTo`.
   */
  reply?: R
  /**
   * The description of the command, used for help messages.
   */
  description?: string
  /**
   * The handler function that will be called when the command is executed.
   *
   * This will only be called when the arguments and reply are valid, and the permissions are granted.
   */
  handler: (cmd: {
    /**
     * The context of the command, this is the same as the context of the bot.
     *
     * See {@link https://grammy.dev/ref/core/context Context}
     */
    context: CommandScopedContext<S, C>
    /**
     * A conversation object to handle complex interactions.
     *
     * See {@link https://grammy.dev/plugins/conversations Conversation}
     */
    conversation: CommandConversation<S, C>
    /**
     * The arguments passed to the command, this is an object with the keys as the argument keys.
     *
     * Optional arguments will be undefined if not passed.
     */
    args: ArgumentMap<A>
    /**
     * The message that was replied to when invoking the command (if any).
     * This will be undefined if the command does not accept a reply.
     */
    repliedTo: RepliedTo<R>
  }) => Promise<void>
}

/**
 * A generic command
 */
export type AnyCommand<TRole extends string = string, C extends Context = Context> = Command<
  CommandArgs,
  CommandReplyTo,
  CommandScope,
  TRole,
  C
>

export type AnyGroupCommand<TRole extends string = string, C extends Context = Context> = Command<
  CommandArgs,
  CommandReplyTo,
  "group" | "both",
  TRole,
  C
>

/**
 * Type guard to check if a command is allowed in groups.
 * @param cmd The command to check
 * @returns A boolean indicating if the command is allowed in groups.
 *
 * @example
 * ```ts
 * import { isAllowedInPrivateOnly } from "@/lib/managed-commands"
 * const commands = new ManagedCommands({
 *   permissionHandler: async ({ command, context }) => {
 *     if (isAllowedInGroups(command)) {
 *       const _ = command.permissions
 *       //    ^ // type: GroupPermissions
 *     }
 *   },
 * })
 * ```
 */
export function isAllowedInGroups<
  A extends CommandArgs,
  R extends CommandReplyTo,
  TRole extends string = string,
  C extends Context = Context,
>(cmd: Command<A, R, CommandScope, TRole, C>): cmd is Command<A, R, "group" | "both", TRole, C> {
  return cmd.scope !== "private"
}

/**
 * Type guard to check if a command is allowed in private chats.
 * @param cmd The command to check
 * @returns A boolean indicating if the command is allowed in private chats.
 *
 * @example
 * ```ts
 * import { isAllowedInPrivateOnly } from "@/lib/managed-commands"
 * const commands = new ManagedCommands({
 *   permissionHandler: async ({ command, context }) => {
 *     if (isAllowedInPrivateOnly(command)) {
 *       const _ = command.permissions
 *       //    ^ // type: PrivatePermissions
 *     }
 *   },
 * })
 * ```
 */
export function isAllowedInPrivateOnly<
  A extends CommandArgs,
  R extends CommandReplyTo,
  TRole extends string = string,
  C extends Context = Context,
>(cmd: Command<A, R, CommandScope, TRole, C>): cmd is Command<A, R, "private", TRole, C> {
  return cmd.scope === "private"
}

export function isAllowedInPrivate<
  A extends CommandArgs,
  R extends CommandReplyTo,
  TRole extends string = string,
  C extends Context = Context,
>(cmd: Command<A, R, CommandScope, TRole, C>): cmd is Command<A, R, "private" | "both", TRole, C> {
  return cmd.scope !== "group"
}

export function isAllowedEverywhere<
  A extends CommandArgs,
  R extends CommandReplyTo,
  TRole extends string = string,
  C extends Context = Context,
>(cmd: Command<A, R, CommandScope, TRole, C>): cmd is Command<A, R, "both", TRole, C> {
  return cmd.scope === "both" || cmd.scope === undefined
}

export function toBotCommands(command: AnyCommand): BotCommand[] {
  const triggers = Array.isArray(command.trigger) ? command.trigger : [command.trigger]
  return triggers.map((trigger) => ({
    command: trigger,
    description: command.description ?? "No description",
  }))
}

export function isForThisScope(cmd: AnyCommand, chatType: "private" | "group" | "supergroup" | "channel"): boolean {
  if (chatType === "channel") return false
  if (cmd.scope === "private") return chatType === "private"
  if (cmd.scope === "group") return chatType === "group" || chatType === "supergroup"
  return true
}
