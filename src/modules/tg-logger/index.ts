import { GrammyError, InlineKeyboard } from "grammy"
import type { Message, User } from "grammy/types"
import { Module } from "@/lib/modules"
import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { redis } from "@/redis"
import { groupMessagesByChat, stripChatId } from "@/utils/chat"
import { fmt, fmtChat, fmtDate, fmtUser } from "@/utils/format"
import type { ModuleShared } from "@/utils/types"
import { after } from "@/utils/wait"
import { modules } from ".."
import type { ModerationAction, PreDeleteResult } from "../moderation/types"
import { type BanAll, getBanAllText } from "./ban-all"
import { grantCreatedMenu, grantMessageMenu } from "./grants"
import { getReportText, type Report, reportMenu } from "./report"
import type * as Types from "./types"

type REPORT_RESULT = "SENT" | "ALREADY_SENT" | "ERROR"

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

const MOD_ACTION_TITLE = (props: ModerationAction) =>
  ({
    MUTE: fmt(({ b }) => b`🤫 ${"duration" in props && props.duration ? "Temp" : "PERMA"} Mute`),
    KICK: fmt(({ b }) => b`👢 Kick`),
    BAN: fmt(({ b }) => b`🚫 ${"duration" in props && props.duration ? "Temp" : "PERMA"} Ban`),
    MULTI_CHAT_SPAM: fmt(({ b }) => [b`📑 Multi Chat Spam (MuteDel)`]),
    UNBAN: fmt(({ b }) => b`✅ Unban`),
    UNMUTE: fmt(({ b }) => b`🎤 Unmute`),
    SILENT: fmt(({ b }) => b`🔶 Possible Harmful Content Detection`),
  })[props.action]

export class TgLogger extends Module<ModuleShared> {
  private reportStorage = new RedisFallbackAdapter<boolean>({
    redis,
    logger,
    prefix: "report",
    ttl: 900,
  })

  constructor(
    public readonly groupId: number,
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

  private async forward(topicId: number, chatId: number, messageIds: number[]): Promise<number[]> {
    if (messageIds.length === 0) return []

    try {
      const res = await this.shared.api.forwardMessages(this.groupId, chatId, messageIds, {
        message_thread_id: topicId,
        disable_notification: true,
      })
      return res.map((r) => r.message_id)
    } catch (e) {
      if (e instanceof GrammyError) {
        if (
          e.description.includes("message to forward not found") ||
          e.description.includes("there are no messages to forward")
        ) {
          logger.warn({ e }, "[TgLogger:forward] Message(s) to forward not found")
        } else if (e.description.includes("MESSAGE_ID_INVALID")) {
          logger.warn({ e, chatId, messageIds }, "[TgLogger:forward] Message ID(s) is not valid for telegram API")
        } else {
          await this.exception({ type: "BOT_ERROR", error: e }, "TgLogger.forward")
          logger.error({ e }, "[TgLogger:forward] There was an error while trying to forward a message")
        }
      } else if (e instanceof Error) {
        await this.exception({ type: "GENERIC", error: e }, "TgLogger.forward")
      }
    }
    return []
  }

  public async report(message: Message, reporter: User): Promise<REPORT_RESULT> {
    if (message.from === undefined) return "ERROR" // should be impossible
    const { invite_link } = await this.shared.api.getChat(message.chat.id)

    const reportKey = `${message.chat.id}_${message.message_id}`

    if (await this.reportStorage.has(reportKey).catch(() => false)) return "ALREADY_SENT"
    await this.reportStorage.write(reportKey, true).catch(() => {})

    const report: Report = { message, reporter } as Report
    const reportText = getReportText(report, invite_link)
    const reply_markup = await reportMenu(report)
    const reportMsg = await this.log(this.topics.actionRequired, reportText, {
      reply_markup,
      disable_notification: false,
    })

    if (!reportMsg) return "ERROR"

    await this.forward(this.topics.actionRequired, message.chat.id, [message.message_id])
    return "SENT"
  }

  // NOTE: this does not delete the messages
  // TODO: better return type
  async preDelete(
    messages: Message[],
    reason: string,
    deleter: User = this.shared.botInfo
  ): Promise<PreDeleteResult | null> {
    if (!messages.length) return null
    const sender = messages[0].from

    const sent = await this.log(
      this.topics.deletedMessages,
      fmt(
        ({ n, b, i, code }) => [
          b`🗑 Delete`,
          sender ? n`${b`Sender:`} ${fmtUser(sender)}` : undefined,
          deleter.id === this.shared.botInfo.id ? i`Automatic deletion by BOT` : n`${b`Deleter:`} ${fmtUser(deleter)}`,
          n`${b`Count:`} ${code`${messages.length}`}`,
          reason ? n`${b`Reason:`} ${reason}` : undefined,
        ],
        { sep: "\n" }
      )
    )
    if (!sent) return null

    const forwardedIds: number[] = []
    for (const [chatId, mIds] of groupMessagesByChat(messages)) {
      if (mIds.length === 0) continue
      forwardedIds.push(...(await this.forward(this.topics.deletedMessages, chatId, mIds)))
    }

    logger.debug({ forwardedIds }, "preDel")

    if (forwardedIds.length === 0) {
      void this.shared.api.deleteMessage(this.groupId, sent.message_id).catch(() => {})
      return null
    }

    return {
      logMessageIds: [sent.message_id, ...forwardedIds],
      count: forwardedIds.length,
      link: `https://t.me/c/${stripChatId(this.groupId)}/${this.topics.deletedMessages}/${sent.message_id}`,
    }
  }

  public async banAll(
    target: User | number,
    reporter: User,
    type: "BAN" | "UNBAN",
    reason?: string
  ): Promise<string | null> {
    const banAll: BanAll = {
      type,
      reporter: reporter,
      reason,
      target,
      state: {
        successCount: 0,
        failedCount: 0,
        jobCount: 0,
      },
    }

    const msg = await this.log(this.topics.banAll, getBanAllText(banAll))

    if (!msg?.message_id) {
      logger.error("[banall] There was an error when initiating banall, no msg.msgId")
      return fmt(
        ({ n, b }) => [
          b`${type} All ERROR!`,
          n`Cannot log the message in tgLogger, therefore cannot start the procedure`,
          n`This should be inspected as it should not never happen`,
        ],
        { sep: "\n" }
      )
    }

    await modules.get("banAll").initiateBanAll(banAll, msg.message_id)
    return fmt(
      ({ n, b, link }) => [
        b`${type} All started!`,
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

  public async moderationAction(props: ModerationAction): Promise<string> {
    const isAutoModeration = props.from.id === this.shared.botInfo.id

    const others: string[] = []
    const { invite_link } = await this.shared.api.getChat(props.chat.id)

    if (props.action === "MULTI_CHAT_SPAM") {
      const groupByChat = groupMessagesByChat(props.messages)
      others.push(fmt(({ b }) => b`\nChats involved:`))
      for (const [chatId, mIds] of groupByChat) {
        const chat = await this.shared.api.getChat(chatId)
        others.push(fmt(({ n, i }) => n`${fmtChat(chat, chat.invite_link)} \n${i`Messages: ${mIds.length}`}`))
      }
    }

    const mainMsg = fmt(
      ({ n, b, skip }) => [
        skip`${MOD_ACTION_TITLE(props)}`,

        n`${b`Target:`} ${fmtUser(props.target)}`,
        !isAutoModeration ? n`${b`Moderator:`} ${fmtUser(props.from)}` : undefined,

        // for MULTI_CHAT we have specific per-chat info
        props.action !== "MULTI_CHAT_SPAM" ? `${b`Group:`} ${fmtChat(props.chat, invite_link)}` : undefined,

        "duration" in props && props.duration
          ? n`${b`Duration:`} ${props.duration.raw} (until ${props.duration.dateStr})`
          : undefined,

        "reason" in props && props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,

        /// per-action specific info, like MULTI_CHAT
        ...others.map((o) => skip`${o}`),
      ],
      { sep: "\n" }
    )

    const reply_markup = props.preDeleteRes
      ? new InlineKeyboard().url("See Deleted Message", props.preDeleteRes.link)
      : undefined
    await this.log(isAutoModeration ? this.topics.autoModeration : this.topics.adminActions, mainMsg, { reply_markup })
    if (!isAutoModeration) void this.logModActionInChat(props)
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
      case "UPDATE":
        msg = fmt(
          ({ b, n }) => [
            props.type === "CREATE" ? b`✳ Create` : b`🔄 Update`,
            n`${b`Group:`} ${fmtChat(props.chat)}`,
            n`${props.type === "CREATE" ? b`Added by:` : b`Requested by:`} ${fmtUser(props.addedBy)}`,
          ],
          {
            sep: "\n",
          }
        )
        reply_markup = new InlineKeyboard().url("Join Group", props.inviteLink)
        break

      case "UPDATE_FAIL":
      case "CREATE_FAIL":
        msg = fmt(
          ({ b, n, i }) => [
            b`! Cannot ${props.type === "CREATE_FAIL" ? "Create" : "Update"}`,
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

  public async grants(props: Types.GrantLog): Promise<string> {
    let msg: string
    switch (props.action) {
      case "USAGE": {
        const { invite_link } = await this.shared.api.getChat(props.chat.id)
        msg = fmt(
          ({ n, b }) => [
            b`💬 Spam-message detected`,
            n`${b`From:`} ${fmtUser(props.from)}`,
            n`${b`Chat:`} ${fmtChat(props.chat, invite_link)}`,
          ],
          { sep: "\n" }
        )
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
        msg = fmt(
          ({ n, b }) => [
            b`✳ New Grant`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`By:`} ${fmtUser(props.by)}`,
            props.reason ? n`${b`Reason:`} ${props.reason}` : undefined,
            n`\n${b`Valid since:`} ${fmtDate(props.since)}`,
            n`${b`Valid until:`} ${fmtDate(props.until)}`,
          ],
          { sep: "\n" }
        )

        const createMenu = await grantCreatedMenu(props.target)
        await this.log(this.topics.grants, msg, { reply_markup: createMenu, disable_notification: false })
        return msg
      }

      case "INTERRUPT":
        msg = fmt(
          ({ n, b }) => [
            b`🛑 Grant Interruption`,
            n`${b`Target:`} ${fmtUser(props.target)}`,
            n`${b`By:`} ${fmtUser(props.by)}`,
          ],
          { sep: "\n" }
        )

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

  private async logModActionInChat(p: ModerationAction): Promise<void> {
    if (
      p.action !== "BAN" &&
      p.action !== "KICK" &&
      p.action !== "MUTE" &&
      p.action !== "UNBAN" &&
      p.action !== "UNMUTE"
    )
      return

    const msg = fmt(
      ({ b, n, skip }) => [
        skip`${MOD_ACTION_TITLE(p)}`,
        n`${b`Target:`} ${fmtUser(p.target, false)}`,
        n`${b`Moderator:`} ${fmtUser(p.from, false)}`,
        "duration" in p && p.duration ? n`${b`Duration:`} ${p.duration.raw} (until ${p.duration.dateStr})` : undefined,
        "reason" in p && p.reason ? n`${b`Reason:`} ${p.reason}` : undefined,
      ],
      { sep: "\n" }
    )

    await this.shared.api
      .sendMessage(p.chat.id, msg, {
        disable_notification: false,
        link_preview_options: { is_disabled: true },
      })
      .catch((error: unknown) => {
        logger.warn(
          { error, action: p.action },
          "[Moderation:logActionInChat] Failed to post moderation action in chat"
        )
        return null
      })
      .then(after(120_000))
      .then((sent) => sent && this.shared.api.deleteMessage(p.chat.id, sent.message_id))
      .catch(() => {})
  }
}
