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

interface LogFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  <T extends object>(obj: T, msg?: string, ...args: any[]): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (obj: unknown, msg?: string, ...args: any[]): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (msg: string, ...args: any[]): void
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
  adapter: ConversationStorage<C, ConversationData>
  permissionHandler: PermissionHandler<TRole>
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

  static parseReplyTo<R extends CommandReplyTo>(
    msg: Message,
    cmd: Command<CommandArgs, R, CommandScope>
  ): Result<RepliedTo<R>, string> {
    if (cmd.reply === "required" && !msg.reply_to_message) {
      return err("This command requires a reply")
    }
    return ok((msg.reply_to_message ?? null) as RepliedTo<R>)
  }

  static parseArgs(msg: string, cmd: Command<CommandArgs, CommandReplyTo, CommandScope>): Result<ArgumentMap, string> {
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
        args[key] = i === cmd.args!.length - 1 ? words.slice(i).join(" ") : words[i]
      }
    }

    return ok(args)
  }

  /**
   * Creates a formatted message to display the usage of a command to the user
   * @param cmd The command to print usage for
   * @returns A markdown formatted string representing the usage of the command
   */
  static formatCommandUsage(cmd: Command<CommandArgs, CommandReplyTo, CommandScope>): string {
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
      ...(cmd.reply ? [i`\nCall while replying to a message:`, b`${cmd.reply!.toUpperCase()}`] : []),
      args.length ? i`\nArgs:` : ``,
      ...args.flatMap(({ key, description }) => [`\n-`, i`${key}:`, description ?? "No description"]),
    ])
  }

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

      ctx.reply(this.commands.map((cmd) => ManagedCommands.formatCommandUsage(cmd)).join("\n\n"))
    })
  }

  createCommand<const A extends CommandArgs, const R extends CommandReplyTo, const S extends CommandScope>(
    cmd: Command<A, R, S, TRole>
  ) {
    cmd.scope = cmd.scope ?? ("both" as S)
    this.commands.push(cmd)
    this.commands.sort((a, b) => a.trigger.localeCompare(b.trigger))
    this.composer.use(
      createConversation(
        async (conv: Conversation, ctx: ConversationContext) => {
          if (!ctx.has(":text")) return

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

          await cmd.handler({
            context: ctx,
            conversation: conv,
            args: args.value,
            repliedTo: repliedTo.value,
          })
        },
        {
          id: cmd.trigger,
        }
      )
    )
    this.composer.command(cmd.trigger, async (ctx) => {
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

      if (cmd.permissions) {
        const allowed = await this.permissionHandler({ command: cmd, context: ctx })
        if (!allowed) {
          this.logger.info(
            { command_permissions: cmd.permissions },
            `[ManagedCommands] command '/${cmd.trigger}' invoked by ${this.printUsername(ctx)} without permissions`
          )
          const reply = await ctx.reply("You are not allowed to execute this command")
          await ctx.deleteMessage()
          setTimeout(() => reply.delete(), 3000)
          return
        }
      }

      await ctx.conversation.enter(cmd.trigger)
    })
    return this
  }

  private printUsername(ctx: CommandContext<C>) {
    if (!ctx.from) return "<N/A>"
    return `@${ctx.from.username ?? "<unset>"} [${ctx.from.id}]`
  }

  middleware: () => MiddlewareFn<C> = () => {
    return this.composer.middleware()
  }
}
