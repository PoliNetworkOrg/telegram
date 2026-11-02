export { CommandsCollection } from "./collection"
export type { AccessControl, CommandScopedContext, DefaultAccessControl, PermissionCheck } from "./command"
export { isAllowedInGroups, isAllowedInPrivate, isAllowedInPrivateOnly } from "./command"
export * from "./context"
export type { CommandAvailability, GroupAvailability } from "./help"

import type { ConversationData, ConversationStorage } from "@grammyjs/conversations"
import { conversations, createConversation } from "@grammyjs/conversations"
import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import type { Api, CommandContext, Context, Middleware, MiddlewareObj, StorageAdapter } from "grammy"
import { Composer, MemorySessionStorage } from "grammy"
import type { BotCommand, BotCommandScope, Chat, Message } from "grammy/types"
import type { Result } from "neverthrow"
import { err, ok } from "neverthrow"
import z from "zod"
import { isFromPrivateChat } from "@/utils/chat"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import type { CommandsCollection } from "./collection"
import type {
  AccessControl,
  AnyCommand,
  ArgumentMap,
  ArgumentOptions,
  Command,
  CommandArgs,
  CommandConversation,
  CommandReplyTo,
  CommandScope,
  CommandScopedContext,
  DefaultAccessControl,
  PermissionCheck,
  RepliedTo,
} from "./command"
import { commandTriggers, isAllowedInGroups, isAllowedInPrivate, isTypedArgumentOptions } from "./command"
import type { ManagedCommandsFlavor } from "./context"
import {
  type CommandAvailability,
  formatHelpFromPrivate,
  formatHelpInGroup,
  formatUsageFromPrivate,
  formatUsageInGroup,
  type GroupAvailability,
  HELP_TRIGGER,
  type HelpSection,
  isAvailable,
  toMenu,
} from "./help"

export type Hook<C extends Context, Params = unknown, TAccess extends AccessControl = DefaultAccessControl> = (
  params: Params & {
    context: CommandContext<C>
    command: AnyCommand<Context, TAccess>
  }
) => Promise<void>
export type InternalHook<C extends Context, Params = unknown, TAccess extends AccessControl = DefaultAccessControl> = (
  params: Params & {
    context: CommandContext<C>
    command: AnyCommand<Context, TAccess>
    conversation: CommandConversation
  }
) => Promise<void> | void
export type ManagedCommandsHooks<
  OC extends Context,
  C extends Context,
  TAccess extends AccessControl = DefaultAccessControl,
> = {
  /**
   * Called when a command is invoked in the wrong scope (e.g. a private-only command is invoked in a group)
   */
  wrongScope?: Hook<OC, unknown, TAccess>
  /**
   * Called when a user without the required permissions invokes a command
   */
  missingPermissions?: Hook<OC, unknown, TAccess>
  /**
   * Called before executing the command handler, can be used to implement custom pre-handler logic, for example logging or analytics
   */
  conversationBegin?: InternalHook<C, unknown, TAccess>
  /**
   * Called when an error is thrown in the command handler
   */
  handlerError?: InternalHook<C, { error: unknown }, TAccess>
  /**
   * Called after executing the command handler, can be used to implement custom post-handler logic, for example logging or analytics
   */
  conversationEnd?: InternalHook<C, unknown, TAccess>
  /**
   * A function to override what counts as a "Group Admin", by default it considers users with Telegram Chat Role of
   * "administrator" or "creator" as group admins, but you can override this to implement your own logic,
   *  for example by checking an external database of admins
   */
  overrideGroupAdminCheck?: (userId: number, chatId: number, context: OC) => Promise<boolean>
  /**
   * Called when a command is invoked, before any processing is done, can be used to implement custom logic that should
   * run before checking permissions or requirements, for example logging or analytics
   */
  commandMiddlewareStart?: Hook<OC, unknown, TAccess>
  /**
   * Called when a command is invoked, after the conversation has entered and the first update is fully processed
   * (i.e after `await ctx.conversation.enter()` returns)
   */
  commandMiddlewareEnd?: Hook<OC, unknown, TAccess>
}

/**
 * Decides whether the sender of an update may run a command.
 *
 * The same function decides both whether a command runs and what `/help` and the commands menu show, so they cannot
 * drift apart. To make that possible it must not look at the chat of the update to decide whether group admin
 * privileges apply: `/help` in private chat asks it about running group commands, and answers `isGroupAdmin`
 * hypothetically, since the bot cannot know in advance which groups the user administers.
 */
export type Authorize<OC extends Context, TAccess extends AccessControl = DefaultAccessControl> = (params: {
  /** The update being handled, to identify the user */
  context: CommandContext<OC>
  command: AnyCommand<Context, TAccess>
  /**
   * Whether the user is an admin of the group where the command would run (see `overrideGroupAdminCheck`), always
   * false outside of groups. Only call it when the answer matters: it may query Telegram.
   */
  isGroupAdmin: () => Promise<boolean>
  /** The built-in group admin check */
  check: () => Promise<PermissionCheck>
}) => Promise<TAccess["authorization"]>

type AuthorizeOptions<OC extends Context, TAccess extends AccessControl> = {
  /**
   * Decides whether the user may run a command, its result is passed to the handler as `authorization`.
   * Defaults to the built-in group admin check, which it receives as `check`.
   *
   * Required when {@link AccessControl} is extended, to read the additional `permissions` and build the `authorization`.
   */
  authorize: Authorize<OC, TAccess>
}

export interface IManagedCommandsOptions<
  OC extends Context,
  C extends Context,
  TAccess extends AccessControl = DefaultAccessControl,
> {
  /**
   * The storage adapter to use for persisting conversations.
   * - {@link https://grammy.dev/plugins/conversations#persisting-conversations conversations plugin documentation}
   * - {@link https://grammy.dev/plugins/session sessions documentation}
   * @default MemorySessionStorage
   */
  adapter?: ConversationStorage<OC, ConversationData>

  /**
   * Additional plugins to apply to the conversation inner composer.
   */
  plugins?: Middleware<C>[]

  /**
   * Hooks to execute on specific events
   */
  hooks?: ManagedCommandsHooks<OC, C, TAccess>

  /**
   * Keeps the Telegram commands menu of each user in line with the commands they can run, or `false` to leave the
   * menus alone. See {@link CommandsMenuOptions}.
   */
  menus?: CommandsMenuOptions | false
}

/** The menu last given to a user in a chat: their own commands, or `null` for the default menu of the chat type */
export type StoredCommandsMenu = { commands: BotCommand[] | null; checkedAt: number }

/**
 * Every chat type gets a default menu with the commands anyone can run (the ones without `permissions`). When a user
 * sends a message, the commands they can run in that chat are computed with the same checks that gate their
 * execution, and if they differ from the default the user gets their own menu in that chat.
 */
export interface CommandsMenuOptions {
  /**
   * Remembers the menu last given to each user in each chat, so that it is sent to Telegram only when it changes.
   *
   * Keep entries for a long time (weeks): a missing entry is taken to mean the user has the default menu.
   * @default MemorySessionStorage
   */
  storage?: StorageAdapter<StoredCommandsMenu>
  /**
   * How long a user's menu is trusted before it is computed again, to pick up changes in their permissions.
   * @default 1 hour
   */
  refreshAfterMs?: number
  /**
   * Waits for the menu to be updated before handling the rest of the update, instead of doing it in the background.
   * Meant for tests.
   * @default false
   */
  blocking?: boolean
  /** Called when updating a menu fails, the menu is retried the next time */
  onError?: (error: unknown) => void
}

export type ManagedCommandsOptions<
  OC extends Context,
  C extends Context,
  TAccess extends AccessControl = DefaultAccessControl,
> = IManagedCommandsOptions<OC, C, TAccess> &
  (DefaultAccessControl extends TAccess ? Partial<AuthorizeOptions<OC, TAccess>> : AuthorizeOptions<OC, TAccess>)

/**
 * A class to manage commands in a grammY bot, with support for argument parsing, permission handling, and hooks for various events.
 * You can create commands with specific triggers, arguments, and permissions, and the class will handle the parsing and execution of the commands, as well as checking permissions and executing hooks.
 *
 * To use, create an instance of the class and pass it as middleware to your bot. Then, use the `createCommand` method to add commands to the instance.
 * @example
 * ```ts
 * const commands = new ManagedCommands()
 * commands.createCommand({
 *   trigger: "ping",
 *   description: "Replies with pong",
 *   handler: async ({ context }) => {
 *     await context.reply("pong")
 *   },
 * })
 *
 * bot.use(commands)
 * ```
 *
 * @typeParam C The context type for the bot, used in the hooks and permission handler. Defaults to `Context`.
 * @typeParam TAccess The application-defined access control, see {@link AccessControl}
 * @see Command for the options available when creating a command
 */
export class ManagedCommands<
  OC extends ManagedCommandsFlavor<Context> = ManagedCommandsFlavor<Context>,
  C extends CommandScopedContext = CommandScopedContext,
  TAccess extends AccessControl = DefaultAccessControl,
> implements MiddlewareObj<OC>
{
  private composer = new Composer<OC>()
  private commands: Record<string, AnyCommand<Context, TAccess>[]> = {}
  private authorize: Authorize<OC, TAccess>
  private hooks: ManagedCommandsHooks<OC, C, TAccess>
  private adapter: ConversationStorage<OC, ConversationData>
  private registeredTriggers = new Set<string>()
  private menus: Required<CommandsMenuOptions> | null
  private defaultMenus: Promise<void> | null = null
  private groupAdminChecks = new WeakMap<object, Promise<boolean>>()

  /**
   * Parses the `reply_to_message` field from the message object
   * @param msg The message object to parse
   * @param cmd The command object to check for requirement
   * @returns A Result containing the parsed `reply_to_message` or an error message
   */
  private static parseReplyTo<R extends CommandReplyTo, TAccess extends AccessControl>(
    msg: Message,
    cmd: Command<CommandArgs, R, CommandScope, Context, TAccess>
  ): Result<RepliedTo<R>, string> {
    if (cmd.reply === "required" && !msg.reply_to_message) {
      return err("This command requires a reply")
    }
    return ok((msg.reply_to_message ?? null) as RepliedTo<R>)
  }

  /**
   * Checks if a specific word is a valid argument for the given options, returns the correct parsed type of the argument.
   * @param value The single word (or words if last) to be parsed as an argument
   * @param argument The options object describing the argument
   * @returns a Result containing either the string or the parsed value from zod or undefined if not required and not
   * provided, or an error if either missing and required or the zod parsing fails in case of a typed argument
   */
  private static parseSingleArg(value: string | undefined, argument: ArgumentOptions) {
    const { key, optional } = argument
    if (!value) {
      if (optional) {
        return ok(undefined)
      } else {
        return err(`Missing argument: ${key}`)
      }
    } else {
      if (isTypedArgumentOptions(argument)) {
        const data = argument.type.safeParse(value)
        if (!data.success) return err(z.prettifyError(data.error))
        else return ok(data.data)
      }
      return ok(value)
    }
  }

  /**
   * Parses the arguments from the command message
   * @param msgText The message string to parse
   * @param cmd The command object to check for arguments requirement
   * @returns A Result containing the parsed arguments as an {@link ArgumentMap} or an error message
   */
  private static parseArgs<TAccess extends AccessControl>(
    msgText: string,
    cmd: Command<CommandArgs, CommandReplyTo, CommandScope, Context, TAccess>
  ): Result<ArgumentMap, string> {
    const args: ArgumentMap = {}
    if (!cmd.args || cmd.args.length === 0) return ok(args)
    const l = cmd.args.length
    const words = msgText.split(" ").slice(1)

    for (const [i, argument] of cmd.args.entries()) {
      const value = i === l - 1 ? words.slice(i).join(" ") : words[i]
      const res = ManagedCommands.parseSingleArg(value, argument)
      if (res.isErr()) return res
      args[argument.key] = res.value
    }

    return ok(args)
  }

  /**
   * Parses all required values for the command to be invoked
   * @param msg The message object to parse
   * @param cmd The command opbect to check for arguments and `reply_to_message` requirements
   * @returns A Result containing the parsed arguments and `reply_to_message`, see {@link Command}
   */
  private static parseCommand<R extends CommandReplyTo, TAccess extends AccessControl>(
    msg: Message,
    cmd: Command<CommandArgs, R, CommandScope, Context, TAccess>
  ): Result<{ args: ArgumentMap; repliedTo: RepliedTo<R> }, string[]> {
    const text = msg.text ?? msg.caption
    if (!text) return err(["Cannot parse arguments"])
    const args = ManagedCommands.parseArgs(text, cmd)
    const repliedTo = ManagedCommands.parseReplyTo(msg, cmd)
    if (args.isOk() && repliedTo.isOk()) {
      return ok({ args: args.value, repliedTo: repliedTo.value })
    }
    const errors: string[] = []
    if (args.isErr()) errors.push(args.error)
    if (repliedTo.isErr()) errors.push(repliedTo.error)
    return err(errors)
  }

  /**
   * Generate a unique ID for a command based on its trigger(s), used for conversation IDs.
   * @param cmd The command
   * @returns a unique ID for the command based on its trigger(s)
   */
  public static commandID<TAccess extends AccessControl>(cmd: AnyCommand<Context, TAccess>) {
    // only available characters in command triggers are a-z, 0-9 and _
    // https://core.telegram.org/bots/features#commands
    return typeof cmd.trigger === "string" ? cmd.trigger : cmd.trigger.join("-")
  }

  /**
   * Creates a new instance of ManagedCommands, which can be used as a middleware
   * @example
   * ```ts
   * const commands = new ManagedCommands()
   * commands.createCommand({
   *   trigger: "ping",
   *   description: "Replies with pong",
   *   handler: async ({ context }) => {
   *     await context.reply("pong")
   *   },
   * })
   *
   * bot.use(commands)
   * ```
   *
   * @param options The options to use for the ManagedCommands instance
   */
  constructor(options?: ManagedCommandsOptions<OC, C, TAccess>) {
    // without an `authorize` option, TAccess is the default and its authorization is the PermissionCheck
    this.authorize = options?.authorize ?? ((({ check }) => check()) as Authorize<OC, TAccess>)
    this.hooks = options?.hooks ?? {}
    this.adapter = options?.adapter ?? new MemorySessionStorage()
    this.menus =
      options?.menus === false
        ? null
        : {
            storage: options?.menus?.storage ?? new MemorySessionStorage<StoredCommandsMenu>(),
            refreshAfterMs: options?.menus?.refreshAfterMs ?? 60 * 60 * 1000,
            blocking: options?.menus?.blocking ?? false,
            onError: options?.menus?.onError ?? (() => {}),
          }
    // /help is handled below, no command can take its trigger
    this.registeredTriggers.add(HELP_TRIGGER)

    if (this.menus) {
      const { blocking } = this.menus
      this.composer.use(async (ctx, next) => {
        const defaults = this.setDefaultMenus(ctx.api)
        const user = ctx.message ? this.syncUserMenu(ctx) : Promise.resolve()
        if (blocking) await Promise.all([defaults, user])
        return next()
      })
    }

    this.composer.use(
      conversations<OC, C>({
        storage: this.adapter,
        plugins: [
          hydrate<CommandScopedContext>(),
          hydrateReply,
          async (ctx, next) => {
            ctx.api.config.use(parseMode("MarkdownV2"))
            await next()
          },
          ...(options?.plugins ?? []),
        ],
      })
    )

    this.composer.command(HELP_TRIGGER, (ctx) => this.help(ctx))
  }

  public getCommands() {
    const cmds: AnyCommand<Context, TAccess>[] = []
    for (const collection in this.commands) {
      cmds.push(...this.commands[collection])
    }
    return cmds
  }

  private findCommand(trigger: string): AnyCommand<Context, TAccess> | undefined {
    return this.getCommands().find((cmd) => commandTriggers(cmd).includes(trigger))
  }

  /** Whether the command can run in this type of chat at all */
  private static isInScope<TAccess extends AccessControl>(
    command: AnyCommand<Context, TAccess>,
    chatType: Chat["type"]
  ): boolean {
    if (chatType === "private") return isAllowedInPrivate(command)
    if (chatType === "group" || chatType === "supergroup") return isAllowedInGroups(command)
    return false
  }

  /** Group allow/deny lists: whether the command is enabled in a group, whoever runs it */
  private static isEnabledInGroup<TAccess extends AccessControl>(
    command: AnyCommand<Context, TAccess>,
    chatId: number
  ): boolean {
    if (!isAllowedInGroups(command)) return false
    const { allowedGroupsId, excludedGroupsId } = command.permissions ?? {}
    if (allowedGroupsId && !allowedGroupsId.includes(chatId)) return false
    if (excludedGroupsId?.includes(chatId)) return false
    return true
  }

  /** Group allow/deny lists: whether there is any group where the command is enabled */
  private static isEnabledInSomeGroup<TAccess extends AccessControl>(command: AnyCommand<Context, TAccess>): boolean {
    if (!isAllowedInGroups(command)) return false
    const { allowedGroupsId, excludedGroupsId } = command.permissions ?? {}
    if (!allowedGroupsId) return true
    return allowedGroupsId.some((id) => !excludedGroupsId?.includes(id))
  }

  /** Whether the sender of the update is an admin of its group, asked to Telegram at most once per update */
  private isGroupAdminHere(ctx: OC): () => Promise<boolean> {
    return () => {
      const from = ctx.from
      const chat = ctx.chat
      if (!from || !chat || (chat.type !== "group" && chat.type !== "supergroup")) return Promise.resolve(false)
      let check = this.groupAdminChecks.get(ctx)
      if (!check) {
        check = this.hooks.overrideGroupAdminCheck
          ? this.hooks.overrideGroupAdminCheck(from.id, chat.id, ctx)
          : ctx.getChatMember(from.id).then(({ status }) => status === "administrator" || status === "creator")
        this.groupAdminChecks.set(ctx, check)
      }
      return check
    }
  }

  /** The built-in group admin check */
  private async checkPermissions(
    command: AnyCommand<Context, TAccess>,
    ctx: CommandContext<OC>,
    isGroupAdmin: () => Promise<boolean>
  ): Promise<PermissionCheck> {
    if (!command.permissions) return { allowed: true, via: "unrestricted" }
    if (!ctx.from) return { allowed: false }
    if (isAllowedInGroups(command) && command.permissions.allowGroupAdmins && (await isGroupAdmin()))
      return { allowed: true, via: "group_admin" }
    return { allowed: true, via: "unrestricted" }
  }

  private authorizeWith(
    command: AnyCommand<Context, TAccess>,
    ctx: CommandContext<OC>,
    isGroupAdmin: () => Promise<boolean>
  ): Promise<TAccess["authorization"]> {
    return this.authorize({
      context: ctx,
      command,
      isGroupAdmin,
      check: () => this.checkPermissions(command, ctx, isGroupAdmin),
    })
  }

  /**
   * The decision on running a command in the chat of the update, `null` when it is not enabled in that group.
   * Scope is checked separately, see {@link ManagedCommands.isInScope}.
   *
   * This is the only path to running a command, and `/help` and the menus use it too.
   */
  private async decideHere(
    command: AnyCommand<Context, TAccess>,
    ctx: CommandContext<OC>
  ): Promise<TAccess["authorization"] | null> {
    const chat = ctx.chat
    if ((chat.type === "group" || chat.type === "supergroup") && !ManagedCommands.isEnabledInGroup(command, chat.id))
      return null
    return this.authorizeWith(command, ctx, this.isGroupAdminHere(ctx))
  }

  /** Whether the sender of the update can run the command in the chat of the update, exactly as when invoking it */
  private async isAvailableHere(command: AnyCommand<Context, TAccess>, ctx: CommandContext<OC>): Promise<boolean> {
    if (!ManagedCommands.isInScope(command, ctx.chat.type)) return false
    try {
      return (await this.decideHere(command, ctx))?.allowed ?? false
    } catch {
      return false
    }
  }

  /**
   * Whether the sender of the update could run the command in a group, from anywhere (e.g. a private chat).
   *
   * Runs the same decision as {@link ManagedCommands.decideHere}, but as the bot doesn't know which groups the user
   * administers, it first decides as if they were not an admin, and if that is denied after asking, as if they were.
   */
  private async availabilityInGroups(
    command: AnyCommand<Context, TAccess>,
    ctx: CommandContext<OC>
  ): Promise<GroupAvailability> {
    if (!ManagedCommands.isEnabledInSomeGroup(command)) return "no"
    try {
      let asked = false
      const notAdmin = async () => {
        asked = true
        return false
      }
      if ((await this.authorizeWith(command, ctx, notAdmin)).allowed) return "yes"
      if (!asked) return "no"
      if ((await this.authorizeWith(command, ctx, async () => true)).allowed) return "if_group_admin"
      return "no"
    } catch {
      return "no"
    }
  }

  /** Where the sender of the update can run the command, as known from a private chat */
  private async availabilityFromPrivate(
    command: AnyCommand<Context, TAccess>,
    ctx: CommandContext<OC>
  ): Promise<CommandAvailability> {
    const [inPrivate, groups] = await Promise.all([
      isAllowedInPrivate(command) ? this.isAvailableHere(command, ctx) : false,
      this.availabilityInGroups(command, ctx),
    ])
    return { private: inPrivate, groups }
  }

  /** Commands grouped by collection, keeping those for which `evaluate` gives a value */
  private async sections<T>(
    evaluate: (cmd: AnyCommand<Context, TAccess>) => Promise<T | null>
  ): Promise<HelpSection<T>[]> {
    const sections = await Promise.all(
      Object.entries(this.commands).map(async ([collection, cmds]) => ({
        collection,
        entries: (await Promise.all(cmds.map(evaluate))).filter((e): e is Awaited<T> => e !== null),
      }))
    )
    return sections.filter((s) => s.entries.length > 0)
  }

  /** The commands the sender of the update can run in the chat of the update */
  private async commandsAvailableHere(ctx: CommandContext<OC>): Promise<AnyCommand<Context, TAccess>[]> {
    const sections = await this.sections(async (cmd) => ((await this.isAvailableHere(cmd, ctx)) ? cmd : null))
    return sections.flatMap((s) => s.entries)
  }

  private async help(ctx: CommandContext<OC>) {
    const isPrivate = ctx.chat.type === "private"
    if (!ctx.from || ctx.chat.type === "channel") return
    // the user is looking for their commands, make sure their menu is up to date too
    if (this.menus) {
      const sync = this.syncUserMenu(ctx, true)
      if (this.menus.blocking) await sync
    }

    const reply = (text: string) => (isPrivate ? ctx.reply(text) : ephemeral(ctx, text))
    if (!isPrivate) await ctx.deleteMessage().catch(() => {})

    const trigger = ctx.match.trim().split(/\s+/)[0]?.replace(/^\//, "").toLowerCase()
    if (trigger) {
      const cmd = this.findCommand(trigger)
      const notFound = fmt(({ n, code }) => n`Command not found. See ${code`/help`} for the commands you can use.`)
      if (!cmd) return reply(notFound)
      if (isPrivate) {
        const availability = await this.availabilityFromPrivate(cmd, ctx)
        return reply(isAvailable(availability) ? formatUsageFromPrivate(cmd, availability) : notFound)
      }
      return reply((await this.isAvailableHere(cmd, ctx)) ? formatUsageInGroup(cmd) : notFound)
    }

    if (isPrivate) {
      const sections = await this.sections(async (cmd) => {
        const availability = await this.availabilityFromPrivate(cmd, ctx)
        return isAvailable(availability) ? { cmd, availability } : null
      })
      return reply(formatHelpFromPrivate(sections))
    }
    const sections = await this.sections(async (cmd) => ((await this.isAvailableHere(cmd, ctx)) ? cmd : null))
    return reply(formatHelpInGroup(sections))
  }

  /** The menu for users who can run only the commands that anyone can run (the ones without `permissions`) */
  private defaultMenu(chatType: "private" | "group"): BotCommand[] {
    return toMenu(
      this.getCommands().filter(
        (cmd) => !cmd.permissions && (chatType === "private" ? isAllowedInPrivate(cmd) : isAllowedInGroups(cmd))
      )
    )
  }

  /** Sets the default menus, once, retrying on the next update if it fails */
  private setDefaultMenus(api: Api): Promise<void> {
    this.defaultMenus ??= Promise.all([
      api.setMyCommands(this.defaultMenu("private"), { scope: { type: "all_private_chats" } }),
      api.setMyCommands(this.defaultMenu("group"), { scope: { type: "all_group_chats" } }),
    ]).then(
      () => {},
      (error: unknown) => {
        this.defaultMenus = null
        this.menus?.onError(error)
      }
    )
    return this.defaultMenus
  }

  /**
   * Gives the sender of the update their own menu in its chat, if their commands differ from the default.
   * Never throws.
   * @param force recompute the menu even if it was checked recently
   */
  private async syncUserMenu(ctx: OC, force = false): Promise<void> {
    const menus = this.menus
    const { from, chat } = ctx
    if (!menus || !from || from.is_bot || !chat) return
    const chatType = chat.type === "private" ? "private" : chat.type === "channel" ? null : "group"
    if (!chatType) return

    try {
      const key = `${chat.id}:${from.id}`
      const now = Date.now()
      const saved = await menus.storage.read(key)
      if (!force && saved && now - saved.checkedAt < menus.refreshAfterMs) return

      // the update may not be a command, but only its sender and chat are looked at
      const available = await this.commandsAvailableHere(ctx as CommandContext<OC>)
      const menu = toMenu(available)
      const commands = JSON.stringify(menu) === JSON.stringify(this.defaultMenu(chatType)) ? null : menu

      // without a saved menu, the user is assumed to have the default one
      if (JSON.stringify(commands) !== JSON.stringify(saved?.commands ?? null)) {
        const scope: BotCommandScope =
          chatType === "private"
            ? { type: "chat", chat_id: chat.id }
            : { type: "chat_member", chat_id: chat.id, user_id: from.id }
        if (commands) await ctx.api.setMyCommands(commands, { scope })
        else await ctx.api.deleteMyCommands({ scope })
      }
      await menus.storage.write(key, { commands, checkedAt: now })
    } catch (error) {
      menus.onError(error)
    }
  }

  /**
   * Creates a new command and adds it to the list of commands
   * @param cmd The options for the command to create, see {@link Command}
   * @returns The ManagedCommands instance for chaining
   */
  createCommand<const A extends CommandArgs, const R extends CommandReplyTo, const S extends CommandScope>(
    cmd: Command<A, R, S, Context, TAccess>,
    collection: string = "default"
  ): this {
    const triggers = Array.isArray(cmd.trigger) ? cmd.trigger : [cmd.trigger]
    for (const trigger of triggers) {
      if (this.registeredTriggers.has(trigger)) {
        throw new Error(
          `[ManagedCommands] Trigger '${trigger}' is already registered (aliases: [${triggers.join(", ")}])`
        )
      }
      this.registeredTriggers.add(trigger)
    }

    cmd.scope = cmd.scope ?? ("both" as S) // default to both
    this.commands[collection] = this.commands[collection] ?? []
    this.commands[collection].push(cmd)
    // TODO: rethink sorting
    // this.commands.sort((a, b) => a.trigger.localeCompare(b.trigger)) // sort the commands by alphabetical order of the trigger
    const id = ManagedCommands.commandID(cmd)

    // create a conversation that handles the command execution
    this.composer.use(
      createConversation(
        async (
          conv: CommandConversation<S>,
          ctx: CommandScopedContext<S>,
          args: ArgumentMap<A>,
          repliedTo: RepliedTo<R>,
          authorization: TAccess["authorization"]
        ) => {
          const hookParams: Parameters<InternalHook<C, unknown, TAccess>>[0] = {
            context: ctx as CommandContext<C>,
            command: cmd,
            // We cast the conversation type to unknown cause hooks cannot be aware of the scope of the specific command
            conversation: conv as unknown as CommandConversation,
          }

          if (this.hooks.conversationBegin) await this.hooks.conversationBegin(hookParams)

          // execute the handler
          await cmd
            .handler({
              context: ctx,
              conversation: conv,
              args: args as ArgumentMap<A>,
              repliedTo,
              authorization,
            })
            .catch(async (error) => {
              // errors should be handled by the hook, if not rethrow them to avoid silent failures
              if (this.hooks.handlerError) await this.hooks.handlerError({ ...hookParams, error })
              else throw error
            })

          if (this.hooks.conversationEnd) await this.hooks.conversationEnd(hookParams)
        },
        { id }
      )
    )
    this.composer.command(cmd.trigger, async (ctx) => {
      if (this.hooks.commandMiddlewareStart) await this.hooks.commandMiddlewareStart({ context: ctx, command: cmd })

      // silently delete the command call if the scope is invalid
      const isPrivate = isFromPrivateChat(ctx)
      if (!ManagedCommands.isInScope(cmd, ctx.chat.type)) {
        if (this.hooks.wrongScope) await this.hooks.wrongScope({ context: ctx, command: cmd })
        return
      }

      // delete the command call if the user is not allowed to use it
      const authorization = await this.decideHere(cmd, ctx)
      if (!authorization?.allowed) {
        if (this.hooks.missingPermissions) await this.hooks.missingPermissions({ context: ctx, command: cmd })
        return
      }

      // check for the requirements in the command invocation
      const requirements = ManagedCommands.parseCommand(ctx.msg, cmd)
      if (requirements.isErr()) {
        // Command messages that don't meet requirements
        // AND are sent in a group/supergroup are deleted from here because
        // they don't reach command handler so they would remain in chat.
        // In private chats we keep them, we don't care
        if (!isPrivate) await ctx.deleteMessage().catch(() => {})

        if (!isPrivate) {
          await ephemeral(
            ctx,
            fmt(({ b, code }) => [
              `Error:`,
              b`${requirements.error.join("\n")}`,
              `\nSee usage with:`,
              code`/help ${Array.isArray(cmd.trigger) ? cmd.trigger[0] : cmd.trigger}`,
            ])
          )
          return
        }

        await ctx.reply(
          fmt(({ b, code }) => [
            `Error:`,
            b`${requirements.error.join("\n")}`,
            `\nSee usage with:`,
            code`/help ${Array.isArray(cmd.trigger) ? cmd.trigger[0] : cmd.trigger}`,
          ])
        )
        return
      }

      const { args, repliedTo } = requirements.value

      // enter the conversation that handles the command execution
      await ctx.conversation.enter(id, args, repliedTo, authorization)
      if (this.hooks.commandMiddlewareEnd) await this.hooks.commandMiddlewareEnd({ context: ctx, command: cmd })
    })
    return this
  }

  /**
   * Adds all the commands from a CommandsCollection to the ManagedCommands instance
   * @param collection The CommandsCollection to add
   * @returns The ManagedCommands instance for chaining
   * @example
   * ```ts
   * const collection = new CommandsCollection()
   *   .createCommand({
   *     trigger: "ping",
   *     description: "Replies with pong",
   *     handler: async ({ context }) => {
   *       await context.reply("pong")
   *     },
   *   })
   *
   * const commands = new ManagedCommands()
   * commands.withCollection(collection)
   *
   * bot.use(commands)
   * ```
   */
  withCollection(...collections: CommandsCollection<TAccess>[]): this {
    collections.forEach((c) => {
      c.flush().forEach((cmd) => {
        this.createCommand(cmd, c.name)
      })
    })
    return this
  }

  /**
   * @deprecated For internal use in grammY, do not call this method directly.
   * Pass the instance of ManagedCommands to the bot instead.
   * @example
   * const commands = new ManagedCommands();
   * bot.use(commands);
   * @returns The middleware function to be used in the bot
   */
  middleware() {
    return this.composer.middleware()
  }
}
