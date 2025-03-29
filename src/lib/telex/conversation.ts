import EventEmitter from "events"
import type { Context as TelegrafContext } from "telegraf"
import { Message, Update } from "telegraf/typings/core/types/typegram"
import { TypedEmitter } from "./emitters.ts"

class InterruptedConversationError extends Error {
  constructor() {
    super("The conversation was interrupted")
  }
}

export interface RequiredArgumentOptions {
  key: string
  description?: string
  optional?: boolean
}
export interface OptionalArgumentOptions extends RequiredArgumentOptions {
  optional: true
}
export type ArgumentOptions = RequiredArgumentOptions | OptionalArgumentOptions
export type ArgumentType<T extends ArgumentOptions> =
  T extends OptionalArgumentOptions ? string | undefined : string

export type CommandArgs = ReadonlyArray<ArgumentOptions>

export type ArgumentMap<A extends CommandArgs = CommandArgs> = {
  [Entry in A[number] as Entry["key"]]: ArgumentType<Entry>
}
export type CommandReplyTo = "required" | "optional" | undefined

export interface Command<A extends CommandArgs, R extends CommandReplyTo> {
  trigger: string
  args?: A
  reply?: R
  description?: string
  handler: (cmd: {
    conversation: ConversationContext
    args: ArgumentMap<A>
    repliedTo: R extends "required"
      ? Message
      : R extends "optional"
        ? Message | null
        : undefined
  }) => Promise<void>
}

export class ConversationContext {
  constructor(
    public conversation: Conversation<Command<CommandArgs, CommandReplyTo>>
  ) {}

  async reply(message: string) {
    this.conversation.lastCtx?.replyWithMarkdownV2(message)
  }

  async ask(question: string) {
    this.conversation.lastCtx?.reply(question)
    const ctx = await this.conversation.waitForProgress()
    return "text" in ctx.message ? ctx.message.text : null
  }

  getLastCtx() {
    return this.conversation.lastCtx
  }
}

export class Conversation<
  CommandType extends Command<CommandArgs, CommandReplyTo> = Command<
    CommandArgs,
    CommandReplyTo
  >,
> {
  context: ConversationContext
  lastCtx: TelegrafContext<Update.MessageUpdate>
  aborted = false
  ee: TypedEmitter<{
    progress: TelegrafContext<Update.MessageUpdate>
    abort: void
    error: Error
    finished: void
  }> = new EventEmitter()

  constructor(
    public command: CommandType,
    handlerParams: Omit<Parameters<typeof command.handler>[0], "conversation">,
    triggeringContext: TelegrafContext<Update.MessageUpdate>
  ) {
    this.context = new ConversationContext(this)
    this.lastCtx = triggeringContext

    this.command
      .handler({ conversation: this.context, ...handlerParams })
      .catch((err: Error) => {
        if (err instanceof InterruptedConversationError) return // The conversation was interrupted as expected
        this.ee.emit("error", err)
      })
      .finally(() => {
        this.ee.emit("finished")
      })
  }

  onError(handler: (err: Error) => void) {
    this.ee.on("error", handler)
    return this
  }

  onFinished(handler: () => void) {
    this.ee.on("finished", handler)
    return this
  }

  progress(ctx: TelegrafContext<Update.MessageUpdate>) {
    this.lastCtx = ctx
    this.ee.emit("progress", ctx)
  }

  waitForProgress() {
    return new Promise<TelegrafContext<Update.MessageUpdate>>(
      (resolve, reject) => {
        if (this.aborted) {
          reject(new InterruptedConversationError())
        }
        this.ee.once("progress", resolve)
        this.ee.once("abort", () => {
          reject(new InterruptedConversationError())
        })
      }
    )
  }

  abort() {
    this.aborted = true
    this.ee.emit("abort")
  }
}
