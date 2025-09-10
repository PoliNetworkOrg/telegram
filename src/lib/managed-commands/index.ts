export * from "./context"
export type { CommandScopedContext } from "./command"
export { isAllowedInGroups, isAllowedInPrivateOnly } from "./command"

import type {
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
import type { Context } from "./context"
import type { ConversationData, ConversationStorage } from "@grammyjs/conversations"
import type { CommandContext, MiddlewareFn, MiddlewareObj } from "grammy"
import type { ChatMember, Message } from "grammy/types"
import type { Result } from "neverthrow"
import type { LogFn } from "pino"

import { conversations, createConversation } from "@grammyjs/conversations"
import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import { Composer, MemorySessionStorage } from "grammy"
import { err, ok } from "neverthrow"

import { fmt } from "@/utils/format"
import { wait } from "@/utils/wait"

import { isTypedArgumentOptions } from "./command"

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
        if (!data.success) return err(data.error.message)
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
    const args = this.parseArgs(text, cmd)
    const repliedTo = this.parseReplyTo(msg, cmd)
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
      conversations<Context, CommandScopedContext>({
        storage: this.adapter,
        plugins: [
          hydrate<CommandScopedContext>(),
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
        async (conv: CommandConversation<S>, ctx: CommandScopedContext<S>) => {
          // check for the requirements in the command invocation
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const message = ctx.message!
          const requirements = ManagedCommands.parseCommand(message, cmd)
          if (requirements.isErr()) {
            // Command messages that don't meet requirements
            // AND are sent in a group/supergroup are deleted from here because
            // they don't reach command handler so they would remain in chat.
            // In private chats we keep them, we don't care
            if (message.chat.type !== "private") await ctx.deleteMessage()

            const msg = await ctx.reply(
              fmt(({ b, skip }) => [
                `Error:`,
                b`${requirements.error.join("\n")}`,
                `\n\nUsage:`,
                skip`\n${ManagedCommands.formatCommandUsage(cmd)}`,
              ])
            )
            if (ctx.chat.type !== "private") {
              await wait(5000)
              await msg.delete()
            }
            return
          }

          const { args, repliedTo } = requirements.value

          // Fianlly execute the handler
          await cmd.handler({
            context: ctx,
            conversation: conv,
            args,
            repliedTo,
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
