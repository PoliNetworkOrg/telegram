export { isAllowedInGroups, isAllowedInPrivateOnly } from "./command"
export type { Context } from "./context"

import { CommandContext, Composer, MemorySessionStorage, MiddlewareFn, MiddlewareObj } from "grammy"
import { ArgumentMap, Command, CommandArgs, CommandReplyTo, CommandScope, RepliedTo } from "./command"
import { ChatMember, Message } from "grammy/types"
import { err, ok, Result } from "neverthrow"
import { getText } from "@/utils/messages"
import { ConversationData, conversations, ConversationStorage, createConversation } from "@grammyjs/conversations"
import { Context, Conversation, ConversationContext } from "./context"
import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import { fmt } from "@/utils/format"
import type { LogFn } from "pino"

export type PermissionHandler<TRole extends string> = (arg: {
  context: CommandContext<Context>
  command: Command<CommandArgs, CommandReplyTo, CommandScope, TRole>
}) => Promise<boolean>

type DefaultRoles = ChatMember["status"]
const defaultPermissionHandler: PermissionHandler<string> = async ({ context, command }) => {
  const { allowedRoles, excludedRoles } = command.permissions ?? {}
  if (!context.from) return false
  const member = await context.getChatMember(context.from.id)

  if (allowedRoles && !allowedRoles.includes(member.status)) return false
  if (excludedRoles && excludedRoles.includes(member.status)) return false

  return true
}

interface Logger {
  info: LogFn
  error: LogFn
}
const defaultLogger: Logger = {
  info: console.log,
  error: console.error,
}

export interface ManagedCommandsOptions<TRole extends string, C extends Context> {
  /**
   * The storage adapter to use for persisting conversations.
   * - {@link https://grammy.dev/plugins/conversations#persisting-conversations conversations plugin documentation}
   * - {@link https://grammy.dev/plugins/session sessions documentation}
   * @default MemorySessionStorage
   */
  adapter: ConversationStorage<C, ConversationData>

  /**
   * The permission handler to use for checking user permissions.
   *
   * By default, this checks the user's status in the chat (e.g. admin, member,
   * etc.) against the allowed and excluded roles.
   *
   * You can override this to implement your own permission logic.
   * @example
   * ```ts
   * const commands = new ManagedCommands({
   *   permissionHandler: async ({ command, context }) => {
   *     const { allowedRoles, excludedRoles } = command.permissions
   *     if (Math.random() > 0.5) return true // don't gable, kids
   *     return false
   *   },
   * })
   * ```
   */
  permissionHandler: PermissionHandler<TRole>

  /**
   * The logger to use for logging messages, you can pass your pino logger here
   * @example
   * ```ts
   * import pino from "pino"
   * const logger = pino({
   *   level: "info",
   * })
   * const commands = new ManagedCommands({
   *   logger: logger,
   * })
   * ```
   * @default console.log
   */
  logger: Logger
}

export class ManagedCommands<TRole extends string = DefaultRoles, C extends Context = Context>
  implements MiddlewareObj<C>
{
  private composer = new Composer<C>()
  private commands: Command<CommandArgs, CommandReplyTo, CommandScope>[] = []
  private permissionHandler: PermissionHandler<TRole>
  private logger: Logger
  private adapter: ConversationStorage<C, ConversationData>

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
   * Parses the arguments from the command message
   * @param msg The message object to parse
   * @param cmd The command object to check for arguments requirement
   * @returns A Result containing the parsed arguments as an {@link ArgumentMap} or an error message
   */
  private static parseArgs(
    msg: string,
    cmd: Command<CommandArgs, CommandReplyTo, CommandScope>
  ): Result<ArgumentMap, string> {
    const args: ArgumentMap = {}
    if (!cmd.args || cmd.args.length === 0) return ok(args)

    const words = msg.split(" ").slice(1)
    for (const [i, { key, optional }] of cmd.args.entries()) {
      if (!words[i]) {
        if (optional) {
          args[key] = undefined
        } else {
          return err(`Missing argument: ${key}`)
        }
      } else {
        args[key] = i === cmd.args.length - 1 ? words.slice(i).join(" ") : words[i]
      }
    }

    return ok(args)
  }

  /**
   * Creates a formatted message to display the usage of a command to the user
   * @param cmd The command to print usage for
   * @returns A markdown formatted string representing the usage of the command
   */
  private static formatCommandUsage(cmd: Command<CommandArgs, CommandReplyTo, CommandScope>): string {
    const args = cmd.args ?? []
    const scope =
      cmd.scope === "private" ? "Private Chat" : cmd.scope === "group" ? "Groups" : "Groups and Private Chat"

    return fmt(({ n, b, i }) => [
      `/${cmd.trigger}`,
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
  constructor(options?: Partial<ManagedCommandsOptions<TRole, C>>) {
    this.permissionHandler = options?.permissionHandler ?? defaultPermissionHandler
    this.logger = options?.logger ?? defaultLogger
    this.adapter = options?.adapter ?? new MemorySessionStorage()

    this.composer.use(
      conversations<Context, ConversationContext>({
        storage: this.adapter,
        plugins: [
          hydrate(),
          hydrateReply,
          async (ctx, next) => {
            ctx.api.config.use(parseMode("MarkdownV2"))
            await next()
          },
        ],
      })
    )

    this.composer.command("help", (ctx) => {
      const text = ctx.message?.text ?? ""
      const [_, cmdArg] = text.replaceAll("/", "").split(" ")
      if (cmdArg) {
        const cmd = this.commands.find((c) => c.trigger === cmdArg)
        if (!cmd) return ctx.reply(fmt(() => "Command not found. See /help."))

        return ctx.reply(ManagedCommands.formatCommandUsage(cmd))
      }

      return ctx.reply(this.commands.map((cmd) => ManagedCommands.formatCommandUsage(cmd)).join("\n\n"))
    })
  }

  /**
   * Creates a new command and adds it to the list of commands
   * @param cmd The options for the command to create, see {@link Command}
   * @returns The ManagedCommands instance for chaining
   */
  createCommand<const A extends CommandArgs, const R extends CommandReplyTo, const S extends CommandScope>(
    cmd: Command<A, R, S, TRole>
  ) {
    cmd.scope = cmd.scope ?? ("both" as S) // default to both
    this.commands.push(cmd) // add the command to the list
    this.commands.sort((a, b) => a.trigger.localeCompare(b.trigger)) // sort the commands by alphabetical order of the trigger

    // create a conversation that handles the command execution
    this.composer.use(
      createConversation(
        async (conv: Conversation, ctx: ConversationContext) => {
          if (!ctx.has(":text")) return // how would this even happen? lets be sure that it's always a text message

          // check for the repliedTo requirement
          const repliedTo = ManagedCommands.parseReplyTo(ctx.msg, cmd)
          if (repliedTo.isErr()) {
            await ctx.reply(
              fmt(({ b }) => [
                `Error:`,
                b`${repliedTo.error}`,
                `\n\nUsage:`,
                `\n${ManagedCommands.formatCommandUsage(cmd)}`,
              ])
            )
            return
          }

          // Parse arguments and construct the argument map
          const args = ManagedCommands.parseArgs(getText(ctx.msg).text ?? "", cmd)
          if (args.isErr()) {
            await ctx.reply(
              fmt(({ b, skip }) => [
                `Error:`,
                b`${args.error}`,
                `\n\nUsage:`,
                skip`\n${ManagedCommands.formatCommandUsage(cmd)}`,
              ])
            )
            return
          }

          // Fianlly execute the handler
          await cmd.handler({
            context: ctx,
            conversation: conv,
            args: args.value,
            repliedTo: repliedTo.value,
          })
        },
        {
          id: cmd.trigger, // the conversation ID is set to the command trigger
        }
      )
    )
    this.composer.command(cmd.trigger, async (ctx) => {
      // silently delete the command call if the scope is invalid
      if (
        (cmd.scope === "private" && ctx.chat.type !== "private") ||
        (cmd.scope === "group" && ctx.chat.type !== "supergroup" && ctx.chat.type !== "group")
      ) {
        await ctx.deleteMessage()
        this.logger.info(
          `[ManagedCommands] command '/${cmd.trigger}' with scope '${cmd.scope}' invoked by ${this.printUsername(ctx)} in a '${ctx.chat.type}' chat.`
        )
        return
      }

      // delete the command call if the user is not allowed to use it
      if (cmd.permissions) {
        const allowed = await this.permissionHandler({ command: cmd, context: ctx })
        if (!allowed) {
          this.logger.info(
            { command_permissions: cmd.permissions },
            `[ManagedCommands] command '/${cmd.trigger}' invoked by ${this.printUsername(ctx)} without permissions`
          )
          // Inform the user of restricted access
          const reply = await ctx.reply("You are not allowed to execute this command")
          await ctx.deleteMessage()
          setTimeout(() => void reply.delete(), 3000)
          return
        }
      }

      // enter the conversation that handles the command execution
      await ctx.conversation.enter(cmd.trigger)
    })
    return this
  }

  /**
   * Creates a string that can be logged with the username and id of the user
   * who invoked the command
   * @param ctx The context of the command
   * @returns a string that can be logged with username and id
   */
  private printUsername(ctx: CommandContext<C>) {
    if (!ctx.from) return "<N/A>"
    return `@${ctx.from.username ?? "<unset>"} [${ctx.from.id}]`
  }

  /**
   * @deprecated For internal use in grammY, do not call this method directly.
   * Pass the instance of ManagedCommands to the bot instead.
   * @example
   * const commands = new ManagedCommands();
   * bot.use(commands);
   * @returns The middleware function to be used in the bot
   */
  middleware: () => MiddlewareFn<C> = () => {
    return this.composer.middleware()
  }
}
