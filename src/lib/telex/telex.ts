import { err, ok, Result } from "neverthrow"
import { Bot, CommandContext, StorageAdapter, type BotConfig, type PollingOptions } from "grammy"
import type { Message } from "grammy/types"
import { ConversationData, conversations, createConversation, VersionedState } from "@grammyjs/conversations"
import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"

import type { ArgumentMap, Command, CommandArgs, CommandReplyTo, CommandScope, RepliedTo } from "./command"
import type { ConversationContext, Context, Conversation } from "./context"
import { getText, sanitizeText } from "@/utils/messages"
import { Logger } from "pino"

type PermissionHandler<TRole extends string> = (arg: {
  context: CommandContext<Context>
  command: Command<CommandArgs, CommandReplyTo, CommandScope, TRole>
}) => Promise<boolean>

export class Telex<TRole extends string> extends Bot<Context> {
  commands: Command<CommandArgs, CommandReplyTo, CommandScope>[] = []
  private permissionHandler?: PermissionHandler<TRole>
  private logger?: Logger
  private _onStop?: (reason?: string) => void

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
    const args = (cmd.args ?? []).map(({ key, optional }) => (optional ? `[_${key}_]` : `<_${key}_>`)).join(" ")

    const argDescs = (cmd.args ?? [])
      .map(({ key, description }) => {
        return `- _${key}_: ${description ?? "No description"}`
      })
      .join("\n")

    const replyTo = cmd.reply ? `_Call while replying to a message_: *${cmd.reply.toUpperCase()}*` : ""
    const scope =
      cmd.scope === "private" ? "Private Chat" : cmd.scope === "group" ? "Groups" : "Groups and Private Chat"

    return sanitizeText(
      [
        `/${cmd.trigger} ${args}`,
        `*${cmd.description ?? "No description"}*`,
        `${argDescs}`,
        `${replyTo}`,
        `Scope: *${scope}*`,
      ]
        .filter((s) => s.length > 0)
        .join("\n")
    )
  }

  constructor(token: string, config?: BotConfig<Context>) {
    super(token, config)
  }

  setup(adapter: StorageAdapter<VersionedState<ConversationData>>) {
    this.use(
      conversations<Context, ConversationContext>({
        storage: adapter,
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
    this.api.config.use(parseMode("MarkdownV2"))
    this.command("start", async (ctx) => {
      const res = "Welcome from PoliNetwork\\! Type /help to get started\\."
      if (ctx.chat.type !== "private") {
        const fromId = ctx.from?.id
        if (fromId) ctx.api.sendMessage(fromId, res)
        ctx.deleteMessage()
        return
      } else {
        ctx.reply(res)
      }
    })

    this.command("help", (ctx) => {
      ctx.reply(this.commands.map((cmd) => Telex.formatCommandUsage(cmd)).join("\n\n"))
    })

    return this
  }

  onStop(cb: (reason?: string) => void) {
    this._onStop = cb
    return this
  }

  setLogger(logger: Logger) {
    this.logger = logger
    return this
  }

  setPermissionChecker(cb: PermissionHandler<TRole>) {
    this.permissionHandler = cb
    return this
  }

  createCommand<const A extends CommandArgs, const R extends CommandReplyTo, const S extends CommandScope>(
    cmd: Command<A, R, S, TRole>
  ) {
    this.commands.push(cmd)
    this.use(
      createConversation(
        async (conv: Conversation, ctx: ConversationContext) => {
          if (!ctx.has(":text")) return

          const repliedTo = Telex.parseReplyTo(ctx.msg, cmd)
          if (repliedTo.isErr()) {
            ctx.reply(`**Error**: ***${repliedTo.error}***\n\nUsage:\n${Telex.formatCommandUsage(cmd)}`)
            return
          }

          const args = Telex.parseArgs(getText(ctx.msg).text ?? "", cmd)
          if (args.isErr()) {
            ctx.reply(`**Error**: ***${args.error}***\n\nUsage:\n${Telex.formatCommandUsage(cmd)}`)
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
    this.command(cmd.trigger, async (ctx) => {
      if (
        (cmd.scope === "private" && ctx.chat.type !== "private") ||
        (cmd.scope === "group" && ctx.chat.type !== "supergroup" && ctx.chat.type !== "group")
      ) {
        await ctx.deleteMessage()
        this.logger?.info(
          `[TELEX] command '/${cmd.trigger}' with scope '${cmd.scope}' invoked by ${ctx.from?.username ?? ctx.from?.id ?? "<unknown>"} in a '${ctx.chat.type}' chat.`
        )
        return
      }

      if (cmd.permissions) {
        if (!this.permissionHandler) {
          this.logger?.error(
            `[TELEX] permissionHandler not configured, but command '/${cmd.trigger}' requires permissions`
          )
          await ctx.deleteMessage()
          return
        }

        const allowed = await this.permissionHandler({ command: cmd, context: ctx })
        if (!allowed) {
          this.logger?.info(
            { command_permissions: cmd.permissions },
            `[TELEX] command '/${cmd.trigger}' invoked by @${ctx.from?.username ?? "<unknown>"} [${ctx.from?.id ?? "<unknown>"}] without permissions`
          )
          const reply = await ctx.reply("You are not allowed to execute this command")
          await ctx.deleteMessage()
          setTimeout(() => ctx.deleteMessages([reply.message_id]), 3000)
          return
        }
      }

      await ctx.conversation.enter(cmd.trigger)
    })
    return this
  }

  override start(options?: PollingOptions) {
    this.api.setMyCommands([{ command: "help", description: "Display all available commands" }])

    process.once("SIGINT", () => this.stop("SIGINT"))
    process.once("SIGTERM", () => this.stop("SIGTERM"))
    return super.start(options)
  }

  override async stop(reason?: string) {
    await super.stop()
    this._onStop?.(reason)
    process.exit(0)
  }
}
