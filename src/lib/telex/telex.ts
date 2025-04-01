import { err, ok, Result } from "neverthrow"
import {
  Bot,
  StorageAdapter,
  type BotConfig,
  type PollingOptions,
} from "grammy"
import type { Message } from "grammy/types"
import {
  ConversationData,
  conversations,
  createConversation,
  VersionedState,
} from "@grammyjs/conversations"
import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"

import {
  ArgumentMap,
  Command,
  CommandArgs,
  CommandReplyTo,
  RepliedTo,
} from "./command"
import type { ConversationContext, Context, Conversation } from "./context"
import { getText } from "@/utils/messages"
import { RedisAdapter } from "@grammyjs/storage-redis"

export class Telex extends Bot<Context> {
  commands: Command<CommandArgs, CommandReplyTo>[] = []

  private _onStop?: (reason?: string) => void = undefined

  static parseReplyTo<R extends CommandReplyTo>(
    msg: Message,
    cmd: Command<CommandArgs, R>
  ): Result<RepliedTo<R>, string> {
    if (cmd.reply === "required" && !msg.reply_to_message) {
      return err("This command requires a reply")
    }
    return ok((msg.reply_to_message ?? null) as RepliedTo<R>)
  }

  static parseArgs(
    msg: string,
    cmd: Command<CommandArgs, CommandReplyTo>
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
        args[key] =
          i === cmd.args!.length - 1 ? words.slice(i).join(" ") : words[i]
      }
    }

    return ok(args)
  }

  /**
   * Creates a formatted message to display the usage of a command to the user
   * @param cmd The command to print usage for
   * @returns A markdown formatted string representing the usage of the command
   */
  static formatCommandUsage(cmd: Command<CommandArgs, CommandReplyTo>): string {
    const args = (cmd.args ?? [])
      .map(({ key, optional }) => (optional ? `[_${key}_]` : `<_${key}_>`))
      .join(" ")

    const argDescs = (cmd.args ?? [])
      .map(({ key, description }) => {
        return `- _${key}_: ${description ?? "No description"}`
      })
      .join("\n")

    const replyTo = cmd.reply
      ? `_Call while replying to a message_: *${cmd.reply.toUpperCase()}*`
      : ""

    return [
      `/${cmd.trigger} ${args}`,
      `*${cmd.description ?? "No description"}*`,
      `${argDescs}`,
      `${replyTo}`,
    ]
      .filter((s) => s.length > 0)
      .join("\n")
      .replace(/[[\]()~`>#+\-=|{}.!]/g, "\\$&")
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
      ctx.reply(
        this.commands.map((cmd) => Telex.formatCommandUsage(cmd)).join("\n\n")
      )
    })

    return this
  }

  onStop(cb: (reason?: string) => void) {
    this._onStop = cb
    return this
  }

  createCommand<const A extends CommandArgs, R extends CommandReplyTo>(
    cmd: Command<A, R>
  ) {
    this.commands.push(cmd as Command<A, R>)
    this.use(
      createConversation(
        async (conv: Conversation, ctx: ConversationContext) => {
          if (!ctx.has(":text")) return

          const repliedTo = Telex.parseReplyTo(ctx.msg, cmd)
          if (repliedTo.isErr()) {
            ctx.reply(
              `**Error**: ***${repliedTo.error}***\n\nUsage:\n${Telex.formatCommandUsage(cmd)}`
            )
            return
          }

          const args = Telex.parseArgs(getText(ctx.msg).text ?? "", cmd)
          if (args.isErr()) {
            ctx.reply(
              `**Error**: ***${args.error}***\n\nUsage:\n${Telex.formatCommandUsage(cmd)}`
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
    this.command(cmd.trigger, async (ctx) => {
      await ctx.conversation.enter(cmd.trigger)
    })
    return this
  }

  override start(options?: PollingOptions) {
    this.api.setMyCommands([
      { command: "help", description: "Display all available commands" },
    ])

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
