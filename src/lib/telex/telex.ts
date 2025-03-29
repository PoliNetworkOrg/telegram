import { err, ok, Result } from "neverthrow"
import { Context, Telegraf } from "telegraf"
import type { Message, Update } from "telegraf/types"
import { message } from "telegraf/filters"
import {
  ArgumentMap,
  Command,
  CommandArgs,
  CommandReplyTo,
  Conversation,
} from "./conversation"
import { getTelegramId, setTelegramId } from "./redis"

export class Telex {
  bot: Telegraf
  commands: Command<CommandArgs, CommandReplyTo>[] = []
  conversations: Map<number, Conversation> = new Map()

  private _onStop?: (reason?: string) => void = undefined

  static getText(message: Message): string | null {
    return "text" in message && message.text !== undefined ? message.text : null
  }

  static parseReplyTo(
    msg: Message.TextMessage,
    cmd: Command<CommandArgs, CommandReplyTo>
  ): Result<Parameters<typeof cmd.handler>[0]["repliedTo"], string> {
    if (cmd.reply === "required" && !msg.reply_to_message) {
      return err("This command requires a reply")
    }
    return ok(msg.reply_to_message ?? null)
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
    this.bot = new Telegraf(token)
    this.bot.on(message(), (ctx, next) => {
      next()
      if (ctx.chat.type === "private") return
      const { username, id } = ctx.message.from
      if (username) setTelegramId(username, id)
    })
    this.bot.on(message(), async (ctx, next) => {
      next() // not sure if this should proceed here
      const text = Telex.getText(ctx.message)
      if (text?.startsWith("/")) return
      const conv = this.conversations.get(ctx.message.chat.id)
      if (conv) conv.progress(ctx)
    })

    this.bot.start(async (ctx) => {
      if (ctx.chat.type !== "private") {
        return
      }
      ctx.setChatMenuButton({ type: "commands" })
      ctx.reply("Welcome from PoliNetwork! Type /help to get started.")
    })

    this.bot.help((ctx) => {
      ctx.replyWithMarkdownV2(
        this.commands.map((cmd) => Telex.formatCommandUsage(cmd)).join("\n\n")
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
    this.bot.command(cmd.trigger, (ctx) =>
      this.commandPreamble(ctx, cmd.trigger)
    )
    return this
  }

  start(cb: () => void) {
    this.bot.telegram.setMyCommands([
      { command: "help", description: "Display all available commands" },
      // ...this.commands.map((cmd) => ({
      //   command: cmd.trigger,
      //   description: cmd.description || 'No description',
      // })),
    ])

    this.bot.launch(cb)

    process.once("SIGINT", () => this.stop("SIGINT"))
    process.once("SIGTERM", () => this.stop("SIGTERM"))
  }

  stop(reason?: string) {
    this.bot.stop("SIGINT")
    this._onStop?.(reason)
    process.exit(0)
  }

  commandPreamble(
    ctx: Context<Update.MessageUpdate<Message.TextMessage>>,
    trigger: string
  ) {
    const conv = this.conversations.get(ctx.message.chat.id)
    if (conv) {
      conv.abort()
      this.conversations.delete(ctx.message.chat.id)
    }

    const cmd = this.commands.find((c) => c.trigger === trigger)
    if (!cmd) {
      ctx.replyWithMarkdownV2(`Unknown command: *${trigger}*`)
      return
    }

    const repliedTo = Telex.parseReplyTo(ctx.message, cmd)
    if (repliedTo.isErr()) {
      ctx.replyWithMarkdownV2(
        `**Error**: ***${repliedTo.error}***\n\nUsage:\n${Telex.formatCommandUsage(cmd)}`
      )
      return
    }

    const args = Telex.parseArgs(ctx.message.text, cmd)
    if (args.isErr()) {
      ctx.replyWithMarkdownV2(
        `**Error**: ***${args.error}***\n\nUsage:\n${Telex.formatCommandUsage(cmd)}`
      )
      return
    }

    const conversation = new Conversation(
      cmd,
      { args: args.value, repliedTo: repliedTo.value },
      ctx as Context<Update.MessageUpdate>
    )
    this.conversations.set(ctx.message.chat.id, conversation)
  }

  getCachedId(username: string): Promise<number | null> {
    return getTelegramId(username)
  }

  get tg() {
    return this.bot
  }
}
