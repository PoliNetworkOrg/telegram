export { CommandsCollection } from "./collection"
export type { CommandScopedContext } from "./command"
export { isAllowedInGroups, isAllowedInPrivateOnly } from "./command"
export * from "./context"

import type { ConversationData, ConversationStorage } from "@grammyjs/conversations"
import { conversations, createConversation } from "@grammyjs/conversations"
import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import type { CommandContext, Context, Middleware, MiddlewareObj } from "grammy"
import { Composer, MemorySessionStorage } from "grammy"
import type { BotCommand, Message } from "grammy/types"
import type { Result } from "neverthrow"
import { err, ok } from "neverthrow"
import z from "zod"
import { asyncFilter, asyncMap } from "@/utils/arrays"
import { isFromGroupChat, isFromPrivateChat } from "@/utils/chat"
import { fmt } from "@/utils/format"
import { once } from "@/utils/once"
import type { ContextWith } from "@/utils/types"
import { wait } from "@/utils/wait"
import type { CommandsCollection } from "./collection"
import type {
  AnyCommand,
  AnyGroupCommand,
  ArgumentMap,
  ArgumentOptions,
  Command,
  CommandArgs,
  CommandConversation,
  CommandReplyTo,
  CommandScope,
  CommandScopedContext,
  RepliedTo,
} from "./command"
import { isAllowedInGroups, isAllowedInPrivate, isTypedArgumentOptions, switchOnScope, toBotCommands } from "./command"
import type { ManagedCommandsFlavor } from "./context"

export type Hook<C extends Context, TRole extends string = string, Params = unknown> = (
  params: Params & {
    context: CommandContext<C>
    command: AnyCommand<TRole>
  }
) => Promise<void>
export type InternalHook<C extends Context, TRole extends string = string, Params = unknown> = (
  params: Params & {
    context: CommandContext<C>
    command: AnyCommand<TRole>
    conversation: CommandConversation
  }
) => Promise<void> | void
export type ManagedCommandsHooks<OC extends Context, C extends Context, TRole extends string = string> = {
  /**
   * Called when a command is invoked in the wrong scope (e.g. a private-only command is invoked in a group)
   */
  wrongScope?: Hook<OC, TRole>
  /**
   * Called when a user without the required permissions invokes a command
   */
  missingPermissions?: Hook<OC, TRole>
  /**
   * Called before executing the command handler, can be used to implement custom pre-handler logic, for example logging or analytics
   */
  conversationBegin?: InternalHook<C, TRole>
  /**
   * Called when an error is thrown in the command handler
   */
  handlerError?: InternalHook<C, TRole, { error: unknown }>
  /**
   * Called after executing the command handler, can be used to implement custom post-handler logic, for example logging or analytics
   */
  conversationEnd?: InternalHook<C, TRole>
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
  commandMiddlewareStart?: Hook<OC, TRole>
  /**
   * Called when a command is invoked, after the conversation has entered and the first update is fully processed
   * (i.e after `await ctx.conversation.enter()` returns)
   */
  commandMiddlewareEnd?: Hook<OC, TRole>
  /**
   * A function to externally cache whether a user has had the commands menu generated for them or not
   * @returns true if the user has had the commands menu generated, false otherwise
   */
  cachedUserSetCommands?: (userId: number, chatId: number) => Promise<boolean>
}

export interface IManagedCommandsOptions<TRole extends string, OC extends Context, C extends Context> {
  /**
   * The storage adapter to use for persisting conversations.
   * - {@link https://grammy.dev/plugins/conversations#persisting-conversations conversations plugin documentation}
   * - {@link https://grammy.dev/plugins/session sessions documentation}
   * @default MemorySessionStorage
   */
  adapter?: ConversationStorage<OC, ConversationData>

  /**
   * A function to get externally defined roles for a specific user.
   *
   * @example
   * ```ts
   * const commands = new ManagedCommands({
   *   getUserRoles: async (userId) => {
   *     const roles = await db.getUserRoles(userId) // Array<"admin" | "user">[]
   *     return roles
   *   },
   * }).createCommand({
   *   trigger: "admincmd",
   *   permissions: {
   *     allowedRoles: ["admin"],
   *   },
   *   handler: async ({ context }) => {
   *     await context.reply("You are an admin!")
   *   }),
   * })
   * ```
   */
  getUserRoles?: (userId: number) => Promise<TRole[]>

  /**
   * Additional plugins to apply to the conversation inner composer.
   */
  plugins?: Middleware<C>[]

  /**
   * Hooks to execute on specific events
   */
  hooks?: ManagedCommandsHooks<OC, C, TRole>
}

export type ManagedCommandsOptions<TRole extends string, OC extends Context, C extends Context> = string extends TRole
  ? Omit<IManagedCommandsOptions<TRole, OC, C>, "getUserRoles"> & { getUserRoles?: never }
  : IManagedCommandsOptions<TRole, OC, C>

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
 * @typeParam TRole A string type representing the possible roles for command permissions. This is used in the `permissions` field of the command options and in the `permissionHandler`.
 * @typeParam C The context type for the bot, used in the hooks and permission handler. Defaults to `Context`.
 * @see Command for the options available when creating a command
 */
export class ManagedCommands<
  TRole extends string = string,
  OC extends ManagedCommandsFlavor<Context> = ManagedCommandsFlavor<Context>,
  C extends CommandScopedContext = CommandScopedContext,
> implements MiddlewareObj<OC>
{
  private composer = new Composer<OC>()
  private commands: Record<string, AnyCommand<TRole>[]> = {}
  private getUserRoles: (userId: number) => Promise<TRole[]>
  private hooks: ManagedCommandsHooks<OC, C, TRole>
  private adapter: ConversationStorage<OC, ConversationData>
  private registeredTriggers = new Set<string>()

  /**
   * Parses the `reply_to_message` field from the message object
   * @param msg The message object to parse
   * @param cmd The command object to check for requirement
   * @returns A Result containing the parsed `reply_to_message` or an error message
   */
  private static parseReplyTo<R extends CommandReplyTo>(
    msg: Message,
    cmd: Command<CommandArgs, R, CommandScope>
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
  private static parseArgs(
    msgText: string,
    cmd: Command<CommandArgs, CommandReplyTo, CommandScope>
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
  private static parseCommand<R extends CommandReplyTo>(
    msg: Message,
    cmd: Command<CommandArgs, R, CommandScope>
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
   * Creates a formatted message to display the usage of a command to the user
   * @param cmd The command to print usage for
   * @returns A markdown formatted string representing the usage of the command
   */
  private static formatCommandUsage(cmd: AnyCommand): string {
    const args = cmd.args ?? []
    const scope = switchOnScope(cmd, {
      private: "👤 Private chats only",
      group: "👥 Groups only",
      both: "🌍 Both private and group chats",
    })
    return fmt(({ n, b, i }) => [
      typeof cmd.trigger === "string" ? `/${cmd.trigger}` : cmd.trigger.map((t) => `/${t}`).join(" | "),
      ...args.map(({ key, optional }) => (optional ? n`[${i`${key}`}]` : n`<${i`${key}`}>`)),
      i`\nDesc:`,
      b`${cmd.description ?? "No description"}`,
      i`\nScope:`,
      b`${scope}`,
      ...(cmd.reply ? [i`\nCall while replying to a message:`, b`${cmd.reply.toUpperCase()}`] : []),
      args.length ? i`\nArgs:` : ``,
      ...args.flatMap(({ key, description }) => [`\n-`, i`${key}:`, description ?? "No description"]),
    ])
  }

  private static formatCommandShort(cmd: AnyCommand): string {
    const args = cmd.args ?? []
    const trigger: string =
      typeof cmd.trigger === "string" ? `/${cmd.trigger}` : cmd.trigger.map((t) => `/${t}`).join(" | ")
    const scope = switchOnScope(cmd, { private: "👤", group: "👥", both: "🌍" })
    const admin = isAllowedInGroups(cmd) && cmd.permissions?.allowGroupAdmins ? "🛡️" : ""
    return fmt(({ i, n }) => [
      trigger,
      ...args.map(({ key, optional }) => (optional ? i` [${key}]` : i` <${key}>`)),
      n`\n\t${scope}${admin}${cmd.description ?? "No description"}`,
    ])
  }

  /**
   * Generate a unique ID for a command based on its trigger(s), used for conversation IDs.
   * @param cmd The command
   * @returns a unique ID for the command based on its trigger(s)
   */
  public static commandID(cmd: AnyCommand) {
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
   * @param TRole You can pass a custom role type that extends string, for example:
   * @example
   * ```ts
   * type MyRole = "cool" | "not_cool"
   * const commands = new ManagedCommands<MyRole>({
   *   permissionHandler: async ({ command, context }) => {
   *     const { allowedRoles, excludedRoles } = command.permissions
   *     if (allowedRoles && !allowedRoles.includes("cool")) return false
   *     return true
   *   },
   * })
   *
   * commands.createCommand({
   *   trigger: "ping",
   *   description: "Replies with pong",
   *   permissions: {
   *     allowedRoles: ["cool"],
   *     excludedRoles: ["not_cool"],
   *   },
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
  constructor(options?: ManagedCommandsOptions<TRole, OC, C>) {
    this.getUserRoles = options?.getUserRoles ?? (async () => [])
    this.hooks = options?.hooks ?? {}
    this.adapter = options?.adapter ?? new MemorySessionStorage()

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

    const setFreeCommands = once(async (ctx: OC) => {
      const freeCommands = this.getCommands().filter((cmd) => this.isCommandAllowedForRoles(cmd, []))
      const privateCommands: BotCommand[] = freeCommands
        .filter((cmd) => isAllowedInPrivate(cmd))
        .flatMap((cmd) => toBotCommands(cmd))
        .concat([{ command: "help", description: "Show available commands" }])
      await ctx.api.setMyCommands(privateCommands, { scope: { type: "all_private_chats" } }).catch(() => {})
      const groupCommands: BotCommand[] = freeCommands
        .filter((cmd) => isAllowedInGroups(cmd) && this.isCommandAllowedInGroup(cmd, -100)) // only include commands that are allowed in all groups
        .flatMap((cmd) => toBotCommands(cmd))
        .concat([{ command: "help", description: "Show available commands" }])
      await ctx.api.setMyCommands(groupCommands, { scope: { type: "all_group_chats" } }).catch(() => {})
    })

    this.composer.use(async (ctx, next) => {
      await setFreeCommands(ctx)
      return next()
    })

    this.composer.on("message").use(async (ctx, next) => {
      if (!ctx.from) return next()
      const shouldSkip = (await this.hooks.cachedUserSetCommands?.(ctx.from.id, ctx.chat.id)) ?? false
      if (shouldSkip) return next()
      const allowedCommands = await this.getAllowedCommandsFor(ctx)
      await ctx.api
        .setMyCommands(allowedCommands.flatMap(toBotCommands), {
          scope: { type: "chat_member", chat_id: ctx.chat.id, user_id: ctx.from.id },
        })
        .catch(() => {})
      return next()
    })

    this.composer.command("help", async (ctx) => {
      if (!ctx.from) return
      const userId = ctx.from.id
      const text = ctx.message?.text ?? ""

      const [_, cmdArg] = text.replaceAll("/", "").split(" ")
      if (cmdArg) {
        const cmd = this.getCommands().find((c) =>
          Array.isArray(c.trigger) ? c.trigger.includes(cmdArg) : c.trigger === cmdArg
        )
        if (!cmd) return ctx.reply(fmt(() => "Command not found. See /help for available commands."))

        return ctx.reply(ManagedCommands.formatCommandUsage(cmd))
      }

      const getUserRoles = once(async () => await this.getUserRoles(userId))
      const isFromGroupAdmin = once(async () => {
        if (ctx.chat.type === "private") return true
        return await this.isFromGroupAdmin(ctx)
      })

      const rawCollections = await asyncMap(Object.entries(this.commands), async ([collection, cmds]) => ({
        collection,
        commands: await asyncFilter(cmds, async (cmd) =>
          this.checkPermissionsCached(cmd, ctx, getUserRoles, isFromGroupAdmin)
        ),
      }))
      const collections = rawCollections.filter((c) => c.commands.length > 0)

      const reply = fmt(
        ({ u, b, skip, n, code, i }) => [
          b`Available commands:`,
          ...collections.flatMap(({ collection, commands }) => [
            collection === "default" ? "" : u`${b`\n${collection}:`}`,
            ...commands.map((cmd) => skip`${ManagedCommands.formatCommandShort(cmd)}`),
          ]),
          i`\n👤: Private only, 👥: Group only, 🌍: Everywhere`,
          i`Commands marked with 🛡️ are restricted to administrators.`,
          n`Type ${code`\/help <command>`} for more details on a specific command.`,
        ],
        { sep: "\n" }
      )

      return ctx.reply(reply)
    })
  }

  public getCommands() {
    const cmds: AnyCommand<TRole>[] = []
    for (const collection in this.commands) {
      cmds.push(...this.commands[collection])
    }
    return cmds
  }

  /**
   * Checks whether a command is allowed in a specific group based on its permissions
   */
  private isCommandAllowedInGroup(command: AnyGroupCommand<TRole>, chatId: number): boolean {
    const { allowedGroupsId, excludedGroupsId } = command.permissions ?? {}
    if (allowedGroupsId && !allowedGroupsId.includes(chatId)) return false
    if (excludedGroupsId?.includes(chatId)) return false
    return true
  }

  /**
   * Checks whether a command is allowed for a specific set of roles based on its permissions
   */
  private isCommandAllowedForRoles(command: AnyCommand<TRole>, roles: TRole[]): boolean {
    const { allowedRoles, excludedRoles } = command.permissions ?? {}
    if (allowedRoles?.every((r) => !roles.includes(r))) return false
    if (excludedRoles?.some((r) => roles.includes(r))) return false
    return true
  }

  private async isFromGroupAdmin(ctx: OC): Promise<boolean> {
    if (!ctx.from || !ctx.chatId) return false
    if (this.hooks.overrideGroupAdminCheck) {
      const isAdmin = await this.hooks.overrideGroupAdminCheck(ctx.from.id, ctx.chatId, ctx)
      if (isAdmin) return true
    } else {
      const { status: groupRole } = await ctx.getChatMember(ctx.from.id)
      if (groupRole === "administrator" || groupRole === "creator") return true
    }
    return false
  }

  private async getAllowedCommandsFor(ctx: ContextWith<OC, "from" | "chat">): Promise<AnyCommand<TRole>[]> {
    const getUserRoles = once(() => this.getUserRoles(ctx.from.id))
    const isFromGroupAdmin = once(() => this.isFromGroupAdmin(ctx))

    return await Promise.all(
      this.getCommands()
        .filter(isFromPrivateChat(ctx) ? (cmd) => isAllowedInPrivate(cmd) : (cmd) => isAllowedInGroups(cmd))
        .map((cmd) =>
          this.checkPermissionsCached(cmd, ctx, getUserRoles, isFromGroupAdmin).then((allowed) =>
            allowed ? cmd : null
          )
        )
    ).then((cmds) => cmds.filter((c) => c !== null))
  }

  private async checkPermissionsCached(
    command: AnyCommand<TRole>,
    ctx: ContextWith<OC, "chat">,
    getUserRoles: () => Promise<TRole[]>,
    isFromGroupAdmin: () => Promise<boolean>
  ): Promise<boolean> {
    if (!command.permissions) return true

    if (isAllowedInGroups(command)) {
      const allowed = this.isCommandAllowedInGroup(command, ctx.chat.id)
      if (!allowed) return false

      if (command.permissions.allowGroupAdmins) {
        const isAdmin = await isFromGroupAdmin()
        if (isAdmin) return true
      }
    }

    const roles = await getUserRoles()
    return this.isCommandAllowedForRoles(command, roles)
  }

  private async checkPermissions(command: AnyCommand<TRole>, ctx: CommandContext<OC>): Promise<boolean> {
    if (!ctx.from) return false
    const userId = ctx.from.id
    return this.checkPermissionsCached(
      command,
      ctx,
      () => this.getUserRoles(userId),
      () => this.isFromGroupAdmin(ctx)
    )
  }

  /**
   * Creates a new command and adds it to the list of commands
   * @param cmd The options for the command to create, see {@link Command}
   * @returns The ManagedCommands instance for chaining
   */
  createCommand<const A extends CommandArgs, const R extends CommandReplyTo, const S extends CommandScope>(
    cmd: Command<A, R, S, TRole>,
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
          repliedTo: RepliedTo<R>
        ) => {
          const hookParams: Parameters<InternalHook<C, TRole>>[0] = {
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
      if ((cmd.scope === "private" && !isPrivate) || (cmd.scope === "group" && !isFromGroupChat(ctx))) {
        if (this.hooks.wrongScope) await this.hooks.wrongScope({ context: ctx, command: cmd })
        return
      }

      // delete the command call if the user is not allowed to use it
      if (cmd.permissions) {
        const allowed = await this.checkPermissions(cmd, ctx)
        if (!allowed) {
          if (this.hooks.missingPermissions) await this.hooks.missingPermissions({ context: ctx, command: cmd })
          return
        }
      }

      // check for the requirements in the command invocation
      const requirements = ManagedCommands.parseCommand(ctx.msg, cmd)
      if (requirements.isErr()) {
        // Command messages that don't meet requirements
        // AND are sent in a group/supergroup are deleted from here because
        // they don't reach command handler so they would remain in chat.
        // In private chats we keep them, we don't care
        if (!isPrivate) await ctx.deleteMessage().catch(() => {})

        const msg = await ctx.reply(
          fmt(({ b, code }) => [
            `Error:`,
            b`${requirements.error.join("\n")}`,
            `\nSee usage with:`,
            code`/help ${Array.isArray(cmd.trigger) ? cmd.trigger[0] : cmd.trigger}`,
          ])
        )
        if (!isPrivate)
          void wait(10_000)
            .then(() => msg.delete())
            .catch(() => {})
        return
      }

      const { args, repliedTo } = requirements.value

      // enter the conversation that handles the command execution
      await ctx.conversation.enter(id, args, repliedTo)
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
  withCollection(...collections: CommandsCollection<TRole>[]): this {
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
