import { GrammyError, InlineKeyboard } from "grammy"
import type { Message, User } from "grammy/types"
import { api } from "@/backend"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { groupMessagesByChat, stripChatId } from "@/utils/chat"
import { fmt, fmtChat, fmtDate, fmtUser } from "@/utils/format"
import type { ModuleShared } from "@/utils/types"
import { type BanAll, banAllMenu, getBanAllText } from "./ban-all"
import { grantCreatedMenu, grantMessageMenu } from "./grants"
import { getReportText, type Report, reportMenu } from "./report"
import type * as Types from "./types"

type Topics = {
  actionRequired: number
  banAll: number
  autoModeration: number
  deletedMessages: number
  adminActions: number
  exceptions: number
  groupManagement: number
  grants: number
}

export class TgLogger extends Module<ModuleShared> {
  constructor(
    private groupId: number,
    private topics: Topics
  ) {
    super()
  }

  private async log(
    topicId: number,
    fmtString: string,
    opts?: Parameters<typeof this.shared.api.sendMessage>[2]
  ): Promise<Message | null> {
    return await this.shared.api
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
    await this.shared.api
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
    const { invite_link } = await this.shared.api.getChat(message.chat.id)

    const report: Report = { message, reporter } as Report
    const reportText = getReportText(report, invite_link)
    const reply_markup = await reportMenu(report)
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
    deleter: User = this.shared.botInfo
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

          deleter.id === this.shared.botInfo.id ? i`Automatic deletion by BOT` : n`${b`Deleter:`} ${fmtUser(deleter)}`,
          n`${b`Count:`} ${code`${messages.length}`}`,

          reason ? n`${b`Reason:`} ${reason}` : undefined,
        ],
        { sep: "\n" }
      )
    )
    if (!sent) return null

    for (const [chatId, mIds] of groupMessagesByChat(messages)) {
      await this.forward(this.topics.deletedMessages, chatId, mIds)
      await this.shared.api.deleteMessages(chatId, mIds)
    }

    return {
      count: messages.length,
      link: `https://t.me/c/${stripChatId(this.groupId)}/${this.topics.deletedMessages}/${sent.message_id}`,
    }
  }

  public async banAll(target: User, reporter: User, type: "BAN" | "UNBAN", reason?: string): Promise<string | null> {
    const direttivo = await api.tg.permissions.getDirettivo.query()

    switch (direttivo.error) {
      case "EMPTY":
        return fmt(({ n }) => n`Error: Direttivo is not set`)

      case "NOT_ENOUGH_MEMBERS":
        return fmt(({ n }) => n`Error: Direttivo has not enough members!`)

      case "TOO_MANY_MEMBERS":
        return fmt(({ n }) => n`Error: Direttivo has too many members!`)

      case "INTERNAL_SERVER_ERROR":
        return fmt(({ n }) => n`Error: there was an internal error while fetching members of Direttivo.`)

      case null:
        break
    }

    const voters = direttivo.members.map((m) => ({
      user: m.user
        ? {
            id: m.userId,
            first_name: m.user.firstName,
            last_name: m.user.lastName,
            username: m.user.username,
            is_bot: m.user.isBot,
            language_code: m.user.langCode,
          }
        : { id: m.userId },
      isPresident: m.isPresident,
      vote: undefined,
    }))

    if (!voters.some((v) => v.isPresident))
      return fmt(
        ({ n, b }) => [b`Error: No member is President!`, n`${b`Members:`} ${voters.map((v) => v.user.id).join(" ")}`],
        {
          sep: "\n",
        }
      )

    const banAll: BanAll = {
      type,
      outcome: "waiting",
      reporter: reporter,
      reason,
      target,
      voters,
      state: {
        successCount: 0,
        failedCount: 0,
        jobCount: 0,
      },
    }

    const menu = await banAllMenu(banAll)
    await this.log(this.topics.banAll, "———————————————")
    const msg = await this.log(this.topics.banAll, getBanAllText(banAll), { reply_markup: menu })
    return fmt(
      ({ n, b, link }) => [
        b`${type} All requested!`,
        msg
          ? n`Check ${link("here", `https://t.me/c/${this.groupId}/${this.topics.banAll}/${msg.message_id}`)}`
          : undefined,
      ],
      { sep: "\n" }
    )
  }

  public async banAllProgress(banAll: BanAll, messageId: number): Promise<void> {
    await this.shared.api.editMessageText(this.groupId, messageId, getBanAllText(banAll), {
      reply_markup: undefined,
      link_preview_options: { is_disabled: true },
    })
  }

  public async moderationAction(props: Types.ModerationAction): Promise<string> {
    const isAutoModeration = props.from.id === this.shared.botInfo.id

    let title: string
    const others: string[] = []
    let deleteRes: Types.DeleteResult | null = null
    const { invite_link } = await this.shared.api.getChat(props.chat.id)

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
          const chat = await this.shared.api.getChat(chatId)
          others.push(fmt(({ n, i }) => n`${fmtChat(chat, chat.invite_link)} \n${i`Messages: ${mIds.length}`}`))
        }

        deleteRes = await this.delete(props.messages, delReason, this.shared.botInfo)
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
          ({ b, n }) => [
            b`‼ Leave failed`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${b`Added by:`} ${fmtUser(props.addedBy)}`,
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

  public async grant(props: Types.GrantLog): Promise<string> {
    let msg: string
    switch (props.action) {
      case "USAGE": {
        const { invite_link } = await this.shared.api.getChat(props.chat.id)
        msg = fmt(({ n, b }) => [
          b`💬 Spam-message detected`,
          n`${b`From:`} ${fmtUser(props.from)}`,
          n`${b`Chat:`} ${fmtChat(props.chat, invite_link)}`,
        ])
        const usageMenu = await grantMessageMenu({
          target: props.from,
          interrupted: false,
          deleted: false,
          chatId: props.chat.id,
          message: props.message,
        })
        await this.log(this.topics.grants, msg, { reply_markup: usageMenu, disable_notification: false })
        await this.forward(this.topics.grants, props.chat.id, [props.message.message_id])
        return msg
      }

      case "CREATE": {
        msg = fmt(({ n, b }) => [
          b`✳ New Grant`,
          n`${b`Target:`} ${fmtUser(props.target)}`,
          n`${b`By:`} ${fmtUser(props.by)}`,
          props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
          n`\n${b`Valid since:`} ${fmtDate(props.since)}`,
          n`${b`Duration:`} ${props.duration.raw} (until ${props.duration.dateStr})`,
        ])

        const createMenu = await grantCreatedMenu(props.target)
        await this.log(this.topics.grants, msg, { reply_markup: createMenu, disable_notification: false })
        return msg
      }

      case "INTERRUPT":
        msg = fmt(({ n, b }) => [
          b`🛑 Grant Interruption`,
          n`${b`Target:`} ${fmtUser(props.target)}`,
          n`${b`By:`} ${fmtUser(props.by)}`,
        ])

        await this.log(this.topics.grants, msg, { reply_markup: undefined, disable_notification: false })
        return msg
    }
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
