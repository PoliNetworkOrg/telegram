import { err, ok, Result } from "neverthrow"
import { Bot, Context } from "grammy"
import type { Message } from "grammy/types"
import {
  conversations,
  createConversation,
  type ConversationFlavor,
} from "@grammyjs/conversations"

import {
  ArgumentMap,
  Command,
  CommandArgs,
  CommandReplyTo,
  RepliedTo,
} from "./command"
import { getTelegramId, setTelegramId } from "./redis"

type TextReturn =
  | {
      text: string
      type: "TEXT" | "CAPTION"
    }
  | { text: null; type: "OTHER" }

export class Telex {
  bot: Bot<ConversationFlavor<Context>>
  commands: Command<CommandArgs, CommandReplyTo>[] = []

  private _onStop?: (reason?: string) => void = undefined

  static getText(message: Message): TextReturn {
    if ("text" in message && message.text)
      return { text: message.text, type: "TEXT" }
    if ("caption" in message && message.caption)
      return { text: message.caption, type: "CAPTION" }

    return { text: null, type: "OTHER" }
  }

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

  constructor(token: string) {
    this.bot = new Bot(token)
    this.bot.use(conversations())
    this.bot.on("message", async (ctx, next) => {
      if (ctx.chat.type !== "private") {
        const { username, id } = ctx.message.from
        if (username) setTelegramId(username, id)
      }
      await next()
    })

    this.bot.command("start", async (ctx) => {
      if (ctx.chat.type !== "private") {
        return
      }
      ctx.reply("Welcome from PoliNetwork! Type /help to get started.")
    })

    this.bot.command("help", (ctx) => {
      ctx.reply(
        this.commands.map((cmd) => Telex.formatCommandUsage(cmd)).join("\n\n"),
        { parse_mode: "MarkdownV2" }
      )
    })
  }

  onStop(cb: (reason?: string) => void) {
    this._onStop = cb
    return this
  }

  createCommand<const A extends CommandArgs, R extends CommandReplyTo>(
    cmd: Command<A, R>
  ) {
    this.commands.push(cmd as Command<A, R>)
    this.bot.use(
      createConversation(async (conv, ctx) => {
        if (!ctx.has(":text")) return

        const repliedTo = Telex.parseReplyTo(ctx.msg, cmd)
        if (repliedTo.isErr()) {
          ctx.reply(
            `**Error**: ***${repliedTo.error}***\n\nUsage:\n${Telex.formatCommandUsage(cmd)}`,
            { parse_mode: "MarkdownV2" }
          )
          return
        }

        const args = Telex.parseArgs(Telex.getText(ctx.msg).text ?? "", cmd)
        if (args.isErr()) {
          ctx.reply(
            `**Error**: ***${args.error}***\n\nUsage:\n${Telex.formatCommandUsage(cmd)}`,
            { parse_mode: "MarkdownV2" }
          )
          return
        }

        await cmd.handler({
          context: ctx,
          conversation: conv,
          args: args.value,
          repliedTo: repliedTo.value,
        })
      }, cmd.trigger)
    )
    this.bot.command(cmd.trigger, async (ctx) => {
      await ctx.conversation.enter(cmd.trigger)
    })
    return this
  }

  start(cb: () => void) {
    this.bot.api.setMyCommands([
      { command: "help", description: "Display all available commands" },
      // ...this.commands.map((cmd) => ({
      //   command: cmd.trigger,
      //   description: cmd.description || 'No description',
      // })),
    ])
    this.bot.start({ onStart: cb })

    process.once("SIGINT", () => this.stop("SIGINT"))
    process.once("SIGTERM", () => this.stop("SIGTERM"))
  }

  stop(reason?: string) {
    this.bot.stop()
    this._onStop?.(reason)
    process.exit(0)
  }

  getCachedId(username: string): Promise<number | null> {
    return getTelegramId(username)
  }

  get tg() {
    return this.bot
  }
}
