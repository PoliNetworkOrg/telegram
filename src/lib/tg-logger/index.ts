import type { Context } from "../managed-commands"
import type * as Types from "./types"
import type { Message, User } from "grammy/types"

import { type Bot, GrammyError, InlineKeyboard } from "grammy"

import { logger } from "@/logger"
import { redis } from "@/redis"
import { duration } from "@/utils/duration"
import { fmt, fmtChat, fmtDate, fmtUser } from "@/utils/format"

import { RedisFallbackAdapter } from "../redis-fallback-adapter"

type Topics = {
  actionRequired: number
  banAll: number
  autoModeration: number
  adminActions: number
  exceptions: number
  groupManagement: number
}

type Report = {
  message: Message
  target: User
  reporter: User
  reportMsg: Message
  reportText: string
}

const REPORT_PREFIX = "rep"

export class TgLogger<C extends Context> {
  private callback_prefix = "tglog" // supposed we have only 1 class instance
  private reportStorage: RedisFallbackAdapter<Report>
  constructor(
    private bot: Bot<C>,
    private groupId: number,
    private topics: Topics
  ) {
    this.reportStorage = new RedisFallbackAdapter({
      redis,
      prefix: "tgloggerreport",
      logger,
    })
    this.setupCallbackQuery()
  }

  private async log(
    topicId: number,
    fmtString: string,
    opts?: Parameters<typeof this.bot.api.sendMessage>[2]
  ): Promise<Message | null> {
    return await this.bot.api
      .sendMessage(this.groupId, fmtString, {
        message_thread_id: topicId,
        disable_notification: true,
        link_preview_options: { is_disabled: true },
        ...opts,
      })
      .catch((e: unknown) => {
        logger.fatal(
          { error: e },
          `Couldn't log in the telegram group (groupId ${this.groupId} topicId ${topicId}) through the bot`
        )
        return null
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

  private setupCallbackQuery() {
    this.bot.on("callback_query:data", async (ctx) => {
      const cqId = ctx.callbackQuery.id
      const [prefix, type, action, id] = ctx.callbackQuery.data.split(":")
      if (prefix !== this.callback_prefix) return

      if (type === REPORT_PREFIX) {
        await this.handleReportAction(action, id, cqId)
      } else {
        await this.bot.api.answerCallbackQuery(cqId, { text: "❌ Unhandled callback query" })
      }
    })
  }

  public async report(message: Message, reporter: User): Promise<boolean> {
    if (message.from === undefined) return false // should be impossible
    const target = message.from

    const id = crypto.randomUUID()

    const { invite_link } = await this.bot.api.getChat(message.chat.id)
    const reply_markup = new InlineKeyboard()
      .text("✅ Ignore", `${this.callback_prefix}:${REPORT_PREFIX}:i:${id}`)
      .text("🗑 Del", `${this.callback_prefix}:${REPORT_PREFIX}:d:${id}`) // must not exceed 64 bytes
      .row()
      .text("👢 Kick", `${this.callback_prefix}:${REPORT_PREFIX}:k:${id}`)
      .text("🚫 Ban", `${this.callback_prefix}:${REPORT_PREFIX}:b:${id}`)
      .row()
      .text("🚨 Start BAN ALL 🚨", `${this.callback_prefix}:${REPORT_PREFIX}:ba:${id}`)

    const reportText = fmt(
      ({ n, b }) => [
        b`⚠️ User Report`,
        n`${b`Group:`} ${fmtChat(message.chat, invite_link)}`,
        n`${b`Target:`} ${fmtUser(target)}`,
        n`${b`Reporter:`} ${fmtUser(reporter)}`,
      ],
      { sep: "\n" }
    )
    const reportMsg = await this.log(this.topics.actionRequired, reportText, {
      reply_markup,
      disable_notification: false,
    })

    if (!reportMsg) return false
    await this.reportStorage.write(id, { message, target, reporter, reportMsg, reportText })

    await this.forward(this.topics.actionRequired, message)

    return true
  }


  private async handleReportAction(actionId: string, id: string, cqId: string): Promise<void> {
    const report = await this.reportStorage.read(id)
    if (!report) return

    const { message, target, reporter, reportMsg, reportText } = report
    let action: string

    switch (actionId) {
      case "d":
        await this.bot.api.deleteMessage(message.chat.id, message.message_id)
        action = "🗑 Delete"
        break

      case "k":
        await this.bot.api.deleteMessage(message.chat.id, message.message_id)
        await this.bot.api.banChatMember(message.chat.id, target.id, {
          until_date: Math.floor(Date.now() / 1000) + duration.values.m,
        })
        action = "👢 Kick"
        break

      case "b":
        await this.bot.api.deleteMessage(message.chat.id, message.message_id)
        await this.bot.api.banChatMember(message.chat.id, target.id)
        action = "🚫 Ban"
        break

      case "i":
        action = "✅ Ignore"
        break

      case "ba":
        action = "🚨 Start BAN ALL (not implemented yet)"
        break

      default:
        await this.bot.api.answerCallbackQuery(cqId, { text: "❌ Unknown action" })
        return
    }

    logger.debug({ reportText }, "report text from redis")
    await this.bot.api.editMessageText(
      reportMsg.chat.id,
      reportMsg.message_id,
      fmt(
        ({ b, n, skip }) => [
          reportMsg.text ? skip`${reportText}` : undefined,
          n`--------------------------------`,
          n`✅ Resolved by ${fmtUser(reporter)}`,
          n`${b`Action:`} ${action}`,
          n`${b`Date:`} ${fmtDate(new Date())}`,
        ],
        { sep: "\n" }
      ),

      { reply_markup: undefined, link_preview_options: { is_disabled: true } }
    )
    await this.bot.api.answerCallbackQuery(cqId, { text: actionId === "ba" ? "❌ Not implemented yet" : undefined })
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
    let chatstr: string
    if (props.message) {
      const { invite_link } = await this.bot.api.getChat(props.message.chat.id)
      chatstr = fmtChat(props.message.chat, invite_link)
    }
    switch (props.action) {
      case "DELETE":
        msg = fmt(
          ({ b, n }) => [
            b`🗑 Delete`,
            n`${b`Sender:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${chatstr}`,
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
            n`${b`Until:`} ${props.duration?.dateStr ?? "FOREVER"}`,
            n`${b`Group:`} ${chatstr}`,
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
            n`${b`Group:`} ${chatstr}`,
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
            n`${b`Group:`} ${chatstr}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "MULTI_CHAT_SPAM": {
        const chats = await Promise.all(
          props.chatCollections.map(async (coll) => {
            const { invite_link } = await this.bot.api.getChat(coll.chatId)
            const chat = await this.bot.api.getChat(coll.chatId)
            chatstr = fmtChat(chat, invite_link)

            return fmt(
              ({ n, i }) =>
                n`${chatstr} \n${i`Messages: ${coll.messages.length} in cache, ${coll.unknownMessages.length} unknown`}`
            )
          })
        )
        msg = fmt(
          ({ b, n, i, skip }) => [
            b`📑 Multi Chat Spam (Del + Mute)`,
            n`${b`Sender:`} ${fmtUser(props.target)}`,
            n`${b`Until:`} ${props.duration.dateStr}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
            b`\nChats involved:`,
            ...chats.map((c) => skip`${c}`),
            i`\nSample message is forwarded...`,
          ],
          {
            sep: "\n",
          }
        )
        break
      }

      case "SILENT":
        msg = fmt(
          ({ b, n }) => [
            b`🔶 Possible Harmful Content Detection`,
            n`${b`Sender:`} ${fmtUser(props.target)}`,
            n`${b`Group:`} ${chatstr}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          ],
          {
            sep: "\n",
          }
        )
        break
    }
    await this.log(this.topics.autoModeration, msg)
    if (props.message)
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

  public async groupManagement(props: Types.GroupManagement): Promise<string> {
    let msg: string
    let reply_markup: InlineKeyboard | undefined
    switch (props.type) {
      case "DELETE":
        msg = fmt(({ b, n }) => [b`💥 Delete`, n`${b`Group:`} ${fmtChat(props.chat)}`], {
          sep: "\n",
        })
        break

      case "LEAVE":
        msg = fmt(
          ({ b, n, i }) => [
            b`💨 Left`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Added by:`} ${fmtUser(props.addedBy)}`,
            n`${i`This user does not have enough permissions to add the bot`}`,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "LEAVE_FAIL":
        msg = fmt(
          ({ b, n, i }) => [
            b`‼️ Cannot Left`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Added by:`} ${fmtUser(props.addedBy)}`,
            n`${i`This user does not have enough permissions to add the bot`}`,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "CREATE":
        msg = fmt(
          ({ b, n }) => [
            b`✳️ Create`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Added by:`} ${fmtUser(props.addedBy)}`,
          ],
          {
            sep: "\n",
          }
        )
        reply_markup = new InlineKeyboard().url("Join Group", props.inviteLink)
        break

      case "CREATE_FAIL":
        msg = fmt(
          ({ b, n, i }) => [
            b`⚠️ Cannot Create`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Reason`}: ${props.reason}`,
            i`Check logs for more details`,
          ],
          {
            sep: "\n",
          }
        )
        if (props.inviteLink) reply_markup = new InlineKeyboard().url("Join Group", props.inviteLink)
        break
    }

    await this.log(this.topics.groupManagement, msg, { reply_markup })
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
          ({ n, b, i, skip, codeblock }) => [
            b`🚨 grammY HTTP Error`,
            n`${props.error.name}`,
            i`${props.error.message}`,
            b`Stack:`,
            codeblock`${JSON.stringify(props.error.stack ?? "stack trace not available", null, 2)}`,
            skip`${contextFmt}`,
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
            codeblock`${JSON.stringify(props.error.stack ?? "stack trace not available", null, 2)}`,
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
            codeblock`${JSON.stringify(props.error.stack ?? "stack trace not available", null, 2)}`,
            skip`${contextFmt}`,
          ],
          {
            sep: "\n",
          }
        )
        break

      case "UNKNOWN":
        msg = fmt(
          ({ b, codeblock, skip }) => [
            b`‼️ Unknown Error`,
            codeblock`${JSON.stringify(props.error, null, 2)}`,
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
