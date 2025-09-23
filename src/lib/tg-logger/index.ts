import { type Bot, type Context, GrammyError, InlineKeyboard } from "grammy"
import type { Message, User } from "grammy/types"
import { logger } from "@/logger"
import { groupMessagesByChat, stripChatId } from "@/utils/chat"
import { duration } from "@/utils/duration"
import { fmt, fmtChat, fmtDate, fmtUser } from "@/utils/format"
import { type CallbackCtx, MenuGenerator } from "../menu"
import type * as Types from "./types"

type Topics = {
  actionRequired: number
  banAll: number
  autoModeration: number
  deletedMessages: number
  adminActions: number
  exceptions: number
  groupManagement: number
}

type Report = {
  message: Message
  target: User
  reporter: User
  reportText: string
}

export class TgLogger<C extends Context> {
  constructor(
    private bot: Bot<C>,
    private groupId: number,
    private topics: Topics
  ) { }

  private async editReportMessage(report: Report, ctx: CallbackCtx<C>, actionText: string) {
    if (!ctx.msg) return
    const msg = ctx.msg
    await this.bot.api.editMessageText(
      msg.chat.id,
      msg.message_id,
      fmt(
        ({ b, n, skip }) => [
          skip`${report.reportText}`,
          n`--------------------------------`,
          n`✅ Resolved by ${fmtUser(report.reporter)}`,
          n`${b`Action:`} ${actionText}`,
          n`${b`Date:`} ${fmtDate(new Date())}`,
        ],
        { sep: "\n" }
      ),

      { reply_markup: undefined, link_preview_options: { is_disabled: true } }
    )
  }

  private reportMenu = MenuGenerator.getInstance<C>().create<Report>("report-command", [
    [
      {
        text: "✅ Ignore",
        cb: async ({ data, ctx }) => {
          await this.editReportMessage(data, ctx, "✅ Ignore")
        },
      },
      {
        text: "🗑 Del",
        cb: async ({ data, ctx }) => {
          await ctx.api.deleteMessage(data.message.chat.id, data.message.message_id)
          await this.editReportMessage(data, ctx, "🗑 Delete")
        },
      },
    ],
    [
      {
        text: "👢 Kick",
        cb: async ({ data, ctx }) => {
          await ctx.api.deleteMessage(data.message.chat.id, data.message.message_id)
          await ctx.api.banChatMember(data.message.chat.id, data.target.id, {
            until_date: Math.floor(Date.now() / 1000) + duration.values.m,
          })
          await this.editReportMessage(data, ctx, "👢 Kick")
        },
      },
      {
        text: "🚫 Ban",
        cb: async ({ data, ctx }) => {
          await ctx.api.deleteMessage(data.message.chat.id, data.message.message_id)
          await ctx.api.banChatMember(data.message.chat.id, data.target.id)
          await this.editReportMessage(data, ctx, "🚫 Ban")
        },
      },
    ],
    [
      {
        text: "🚨 Start BAN ALL 🚨",
        cb: async ({ data, ctx }) => {
          await this.editReportMessage(data, ctx, "🚨 Start BAN ALL(not implemented yet)")
          return "❌ Not implemented yet"
        },
      },
    ],
  ])

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

  private async forward(topicId: number, chatId: number, messageIds: number[]): Promise<void> {
    await this.bot.api
      .forwardMessages(this.groupId, chatId, messageIds, {
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

  public async report(message: Message, reporter: User): Promise<boolean> {
    if (message.from === undefined) return false // should be impossible
    const target = message.from

    const { invite_link } = await this.bot.api.getChat(message.chat.id)
    const reportText = fmt(
      ({ n, b }) => [
        b`⚠️ User Report`,
        n`${b`Group:`} ${fmtChat(message.chat, invite_link)}`,
        n`${b`Target:`} ${fmtUser(target)}`,
        n`${b`Reporter:`} ${fmtUser(reporter)}`,
      ],
      { sep: "\n" }
    )

    const reply_markup = await this.reportMenu({ message, target, reporter, reportText })
    const reportMsg = await this.log(this.topics.actionRequired, reportText, {
      reply_markup,
      disable_notification: false,
    })

    if (!reportMsg) return false

    await this.forward(this.topics.actionRequired, message.chat.id, [message.message_id])
    return true
  }

  async delete(
    messages: Message[],
    reason: string,
    deleter: User = this.bot.botInfo
  ): Promise<Types.DeleteResult | null> {
    if (!messages.length) return null
    const sendersMap = new Map<number, User>()
    messages
      .map((m) => m.from)
      .filter((m): m is User => m !== undefined)
      .forEach((u) => {
        if (!sendersMap.has(u.id)) sendersMap.set(u.id, u)
      })
    const senders = Array.from(sendersMap.values())
    if (!senders.length) return null

    const sent = await this.log(
      this.topics.deletedMessages,
      fmt(
        ({ n, b, i, code }) => [
          b`🗑 Delete`,
          senders.length > 1
            ? n`${b`Senders:`} \n - ${senders.map(fmtUser).join("\n - ")}`
            : n`${b`Sender:`} ${fmtUser(senders[0])}`,

          deleter.id === this.bot.botInfo.id ? i`Automatic deletion by BOT` : n`${b`Deleter:`} ${fmtUser(deleter)}`,
          n`${b`Count:`} ${code`${messages.length}`}`,

          reason ? n`${b`Reason:`} ${reason}` : undefined,
        ],
        { sep: "\n" }
      )
    )
    if (!sent) return null

    for (const [chatId, mIds] of groupMessagesByChat(messages)) {
      await this.forward(this.topics.deletedMessages, chatId, mIds)
      await this.bot.api.deleteMessages(chatId, mIds)
    }

    return {
      count: messages.length,
      link: `https://t.me/c/${stripChatId(this.groupId)}/${this.topics.deletedMessages}/${sent.message_id}`,
    }
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

  public async moderationAction(props: Types.ModerationAction): Promise<string> {
    const isAutoModeration = props.from.id === this.bot.botInfo.id

    let title: string
    const others: string[] = []
    let deleteRes: Types.DeleteResult | null = null
    const { invite_link } = await this.bot.api.getChat(props.chat.id)

    const delReason = `${props.action}${"reason" in props && props.reason ? ` -- ${props.reason}` : ""}`
    switch (props.action) {
      case "MUTE":
        title = fmt(({ b }) => b`🤫 ${props.duration ? "Temp" : "PERMA"} Mute`)
        if (props.message) deleteRes = await this.delete([props.message], delReason, props.from)
        break

      case "KICK":
        title = fmt(({ b }) => b`👢 Kick`)
        if (props.message) deleteRes = await this.delete([props.message], delReason, props.from)
        break

      case "BAN":
        title = fmt(({ b }) => b`🚫 ${props.duration ? "Temp" : "PERMA"} Ban`)
        if (props.message) deleteRes = await this.delete([props.message], delReason, props.from)
        break

      case "MULTI_CHAT_SPAM": {
        title = fmt(({ b }) => [b`📑 Multi Chat Spam (MuteDel)`])

        const groupByChat = groupMessagesByChat(props.messages)
        others.push(fmt(({ b }) => b`\nChats involved:`))
        for (const [chatId, mIds] of groupByChat) {
          const chat = await this.bot.api.getChat(chatId)
          others.push(fmt(({ n, i }) => n`${fmtChat(chat, chat.invite_link)} \n${i`Messages: ${mIds.length}`}`))
        }

        deleteRes = await this.delete(props.messages, delReason, this.bot.botInfo)
        break
      }

      case "UNBAN":
        title = fmt(({ b }) => b`✅ Unban`)
        break

      case "UNMUTE":
        title = fmt(({ b }) => b`🎤 Unmute`)
        break

      case "SILENT":
        title = fmt(({ b }) => b`🔶 Possible Harmful Content Detection`)
        break
    }

    const mainMsg = fmt(
      ({ n, b, skip }) => [
        skip`${title}`,

        n`${b`Target:`} ${fmtUser(props.target)}`,

        // for MULTI_CHAT we have specific per-chat info
        props.action !== "MULTI_CHAT_SPAM" ? `${b`Group:`} ${fmtChat(props.chat, invite_link)}` : undefined,

        "duration" in props && props.duration
          ? n`${b`Duration:`} ${props.duration.raw} (until ${props.duration.dateStr})`
          : undefined,

        "reason" in props && props.reason ? fmt(({ n, b }) => n`${b`Reason:`} ${props.reason}`) : undefined,

        /// per-action specific info, like MULTI_CHAT
        ...others.map((o) => skip`${o}`),
      ],
      { sep: "\n" }
    )

    const reply_markup = deleteRes ? new InlineKeyboard().url("See Deleted Message", deleteRes.link) : undefined
    await this.log(isAutoModeration ? this.topics.autoModeration : this.topics.adminActions, mainMsg, { reply_markup })
    return mainMsg
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
            b`‼ Cannot Left`,
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
            b`✳ Create`,
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
            b`! Cannot Create`,
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
            b`‼ Generic Error`,
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
            b`‼ Unknown Error`,
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
