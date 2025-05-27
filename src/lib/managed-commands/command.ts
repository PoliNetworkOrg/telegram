import type { Conversation, ConversationContext } from "./context"
import type { Message } from "grammy/types"
import type { z } from "zod/v4"

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
  /**
   * The command trigger, the string that will be used to call the command.
   */
  trigger: string
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
    context: ConversationContext
    /**
     * A conversation object to handle complex interactions.
     *
     * See {@link https://grammy.dev/plugins/conversations Conversation}
     */
    conversation: Conversation
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
export function isAllowedInGroups<A extends CommandArgs, R extends CommandReplyTo, TRole extends string = string>(
  cmd: Command<A, R, CommandScope, TRole>
): cmd is Command<A, R, "group" | "both", TRole> {
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
export function isAllowedInPrivateOnly<A extends CommandArgs, R extends CommandReplyTo, TRole extends string = string>(
  cmd: Command<A, R, CommandScope, TRole>
): cmd is Command<A, R, "private", TRole> {
  return cmd.scope === "private"
}
