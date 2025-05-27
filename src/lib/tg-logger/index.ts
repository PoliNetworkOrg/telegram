import type { Context } from "../managed-commands"
import type * as Types from "./types"
import type { Message } from "grammy/types"

import { type Bot, GrammyError } from "grammy"

import { logger } from "@/logger"
import { fmt, fmtChat, fmtUser } from "@/utils/format"

type Topics = {
  actionRequired: number
  banAll: number
  autoModeration: number
  adminActions: number
  exceptions: number
}

export class TgLogger<C extends Context> {
  constructor(
    private bot: Bot<C>,
    private groupId: number,
    private topics: Topics
  ) {}

  private async log(topicId: number, fmtString: string): Promise<void> {
    await this.bot.api
      .sendMessage(this.groupId, fmtString, {
        message_thread_id: topicId,
        disable_notification: true,
        link_preview_options: { is_disabled: true },
      })
      .catch((e: unknown) => {
        logger.fatal(
          { error: e },
          `Couldn't log in the telegram group (groupId ${this.groupId} topicId ${topicId}) through the bot`
        )
      })
  }

  private async forward(topicId: number, message: Message): Promise<void> {
    await this.bot.api
      .forwardMessage(this.groupId, message.chat.id, message.message_id, {
        message_thread_id: topicId,
        disable_notification: true,
      })
      .catch(async (e: unknown) => {
        if (e instanceof GrammyError) {
          if (e.description === "Bad Request: message to forward not found") {
            await this.log(
              topicId,
              fmt(({ b, i }) => [b`Could not forward the message`, i`It probably was deleted before forwarding`], {
                sep: "\n",
              })
            )
          } else {
            await this.exception({ type: "BOT_ERROR", error: e }, "TgLogger.forward")
            logger.error({ e }, "[TgLogger:forward] There was an error while trying to forward a message")
          }
        } else if (e instanceof Error) {
          await this.exception({ type: "GENERIC", error: e }, "TgLogger.forward")
        }
      })
  }

  public async banAll(props: Types.BanAllLog): Promise<string> {
    let msg: string
    if (props.type === "BAN") {
      msg = fmt(
        ({ b, n }) => [
          b`🚫 Ban ALL`,
          n`${b`Target:`} ${fmtUser(props.target)}`,
          n`${b`Admin:`} ${fmtUser(props.from)}`,
          props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
        ],
        { sep: "\n" }
      )
    } else {
      msg = fmt(
        ({ b, n }) => [
          b`✅ Unban ALL`,
          n`${b`Target:`} ${fmtUser(props.target)}`,
          n`${b`Admin:`} ${fmtUser(props.from)}`,
        ],
        {
          sep: "\n",
        }
      )
    }

    await this.log(this.topics.banAll, msg)
    return msg
  }

  public async autoModeration(props: Types.AutoModeration): Promise<string> {
    let msg: string
    switch (props.action) {
      case "DELETE":
        msg = fmt(
          ({ b, n }) => [
            b`🗑 Delete`,
            n`${b`Sender:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.message.chat)}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "MUTE_DELETE":
        msg = fmt(
          ({ b, n }) => [
            b`🗑 Delete + 🤫 Mute`,
            n`${b`Sender:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.message.chat)}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "KICK_DELETE":
        msg = fmt(
          ({ b, n }) => [
            b`🗑 Delete + 👢 Kick`,
            n`${b`Sender:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.message.chat)}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "BAN_DELETE":
        msg = fmt(
          ({ b, n }) => [
            b`🗑 Delete + 🚫 Ban`,
            n`${b`Sender:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.message.chat)}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break
    }
    await this.log(this.topics.autoModeration, msg)
    await this.bot.api.forwardMessage(this.groupId, props.message.chat.id, props.message.message_id, {
      message_thread_id: this.topics.autoModeration,
      disable_notification: true,
    })
    return msg
  }

  public async adminAction(props: Types.AdminAction): Promise<string> {
    let msg: string
    switch (props.type) {
      case "DELETE":
        msg = fmt(
          ({ b, n }) => [
            b`🗑 Delete`,
            n`${b`Sender:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.message.chat)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "BAN":
        msg = fmt(
          ({ b, n }) => [
            b`🚫 ${props.duration ? "Temp" : "PERMA"} Ban`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
            props.duration ? n`${b`Duration:`} ${props.duration.raw} (until ${props.duration.dateStr})` : undefined,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "UNBAN":
        msg = fmt(
          ({ b, n }) => [
            b`✅ Unban`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "MUTE":
        msg = fmt(
          ({ b, n }) => [
            b`🤫 ${props.duration ? "Temp" : "PERMA"} Mute`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
            props.duration ? n`${b`Duration:`} ${props.duration.raw} (until ${props.duration.dateStr})` : undefined,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "UNMUTE":
        msg = fmt(
          ({ b, n }) => [
            b`🎤 Unmute`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "KICK":
        msg = fmt(
          ({ b, n }) => [
            b`👢 Kick`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break
    }

    await this.log(this.topics.adminActions, msg)
    if (props.type === "DELETE") await this.forward(this.topics.adminActions, props.message)
    return msg
  }

  public async exception(props: Types.ExceptionLog, context?: string): Promise<string> {
    const contextFmt = context ? fmt(({ n, b }) => n`\n${b`Context:`} ${context}`) : undefined
    let msg: string = ""
    switch (props.type) {
      case "BOT_ERROR":
        msg = fmt(
          ({ b, link, n, i, code, codeblock, skip }) => [
            b`🚨 grammY Error`,
            n`${b`Called Method:`} ${code`${props.error.method}`} ${link(
              "API docs",
              `https://core.telegram.org/bots/api#${props.error.method.toLowerCase()}`
            )}`,

            i`${props.error.error_code}: ${props.error.description}`,
            b`Payload:`,
            codeblock`${JSON.stringify(props.error.payload, null, 2)}`,
            b`Stack:`,
            codeblock`${JSON.stringify(props.error.stack ?? "stack trace not available", null, 2)}`,
            skip`${contextFmt}`,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "HTTP_ERROR":
        msg = fmt(
          ({ n, b, i, codeblock }) => [
            b`🚨 grammY HTTP Error`,
            n`${props.error.name}`,
            i`${props.error.message}`,
            b`Stack:`,
            codeblock`${JSON.stringify(props.error.stack ?? "stack trace not available", null, 2)}`,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "UNHANDLED_PROMISE":
        msg = fmt(
          ({ b, u, n, i, codeblock, skip }) => [
            b`${u`🛑 UNHANDLED PROMISE REJECTION`}`,
            n`${props.error.name}`,
            i`${props.error.message}`,
            codeblock`${props.error.stack ?? `no stack trace available`}`,
            skip`${contextFmt}`,
          ],
          {
            sep: "\n",
          }
        )
        break
      case "GENERIC":
        msg = fmt(
          ({ b, n, i, codeblock, skip }) => [
            b`‼️ Generic Error`,
            n`${props.error.name}`,
            i`${props.error.message}`,
            codeblock`${props.error.stack ?? `no stack trace available`}`,
            skip`${contextFmt}`,
          ],
          {
            sep: "\n",
          }
        )
        break
    }

    await this.log(this.topics.exceptions, msg)
    return msg
  }
}
