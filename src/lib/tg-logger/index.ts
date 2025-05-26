import type { Context } from "../managed-commands"
import type * as Types from "./types"

import { type Bot, GrammyError, HttpError } from "grammy"

import { fmt, fmtUser } from "@/utils/format"

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
    await this.bot.api.sendMessage(this.groupId, fmtString, { message_thread_id: topicId })
  }

  public async banAll(props: Types.BanAllLog): Promise<void> {
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
  }

  public async autoModeration(props: Types.AutoModeration): Promise<void> {
    let msg: string
    switch (props.action) {
      case "DELETE":
        msg = fmt(
          ({ b, n }) => [
            b`🗑 Delete`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
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
            n`${b`Target:`} ${fmtUser(props.target)}`,
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
            n`${b`Target:`} ${fmtUser(props.target)}`,
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
            n`${b`Target:`} ${fmtUser(props.target)}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break
    }
    await this.log(this.topics.banAll, msg)
    await this.bot.api.forwardMessage(this.groupId, props.message.chat.id, props.message.message_id, {
      message_thread_id: this.topics.banAll,
      disable_notification: true,
    })
  }

  public async adminAction(props: Types.AdminAction): Promise<void> {
    let msg: string
    switch (props.type) {
      case "TEMP_BAN":
        msg = fmt(
          ({ b, n }) => [
            b`🚫 Temp Ban`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
            n`${b`Duration:`} ${props.duration.raw} (until ${props.duration.dateStr})`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "BAN":
        msg = fmt(
          ({ b, n }) => [
            b`🚫 PERMA Ban`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
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
            n`${b`Admin:`} ${fmtUser(props.from)}`,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "TEMP_MUTE":
        msg = fmt(
          ({ b, n }) => [
            b`🤫 Temp Mute`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
            n`${b`Duration:`} ${props.duration.raw} (until ${props.duration.dateStr})`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "MUTE":
        msg = fmt(
          ({ b, n }) => [
            b`🤫 PERMA Mute`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`Admin:`} ${fmtUser(props.from)}`,
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
            n`${b`Admin:`} ${fmtUser(props.from)}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break
    }

    await this.log(this.topics.banAll, msg)
  }

  public async exception(props: Types.ExceptionLog<C>): Promise<void> {
    let msg: string
    if (props.type === "UNHANDLED_PROMISE") {
      msg = fmt(
        ({ b, u, n, i, codeblock }) => [
          b`${u`🛑 UNHANDLED PROMISE REJECTION`}`,
          n`${props.error.name}`,
          i`${props.error.message}`,
          codeblock`${props.error.stack ?? `no stack trace available`}`,
        ],
        {
          sep: "\n",
        }
      )
    } else {
      msg = fmt(
        ({ b, code, n, i, codeblock, u, link }) => {
          const lines = [n`⚠️ An error occured inside the middleware stack`, b`${u`${props.error.message}`}\n`]
          const error = props.error.error
          if (error instanceof GrammyError) {
            lines.push(
              n`${u`${b`grammY Error`} while calling method`}: ${link(
                error.method,
                `https://core.telegram.org/bots/api#${error.method.toLowerCase()}`
              )} (${code`${error.error_code}`})`
            )
            lines.push(n`Description: ${i`${error.description}`}`)
            lines.push(n`Payload:`, codeblock`${JSON.stringify(error.payload, null, 2)}`)
          } else if (error instanceof HttpError) {
            lines.push(n`${u`HTTP Error`}: ${code`${error.name}`}`)
          } else if (error instanceof Error) {
            lines.push(n`Unknown Error: ${code`${error.name}`}`)
          } else {
            lines.push(n`Something besides an ${code`Error`} has been thrown, check the logs for more info`)
          }
          return lines
        },
        { sep: "\n" }
      )
    }
    await this.log(this.topics.exceptions, msg)
  }
}
