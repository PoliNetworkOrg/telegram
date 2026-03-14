import type { Span } from "@opentelemetry/api"
import { Composer, type Context, type MiddlewareObj } from "grammy"
import type { Chat, ChatMember, Message, User } from "grammy/types"
import { err, ok, type Result } from "neverthrow"
import { type ApiInput, api } from "@/backend"
import { logger } from "@/logger"
import { BotAttributes, recordException, withSpan } from "@/telemetry"
import { groupMessagesByChat, RestrictPermissions } from "@/utils/chat"
import { type Duration, duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { modules } from ".."
import type { ModerationAction, ModerationError, ModerationErrorCode, PreDeleteResult } from "./types"

function deduceModerationAction(oldMember: ChatMember, newMember: ChatMember): ModerationAction["action"] | null {
  const prev = oldMember.status
  const curr = newMember.status

  if (prev === "left" && curr === "member") return null // join event
  if (prev === "member" && curr === "left") return null // left event

  if (prev === "kicked" && curr === "left") return "UNBAN"
  if (prev === "member" && curr === "kicked") return "BAN"
  if (prev === "member" && curr === "restricted" && !newMember.can_send_messages) return "MUTE"
  if (prev === "restricted" && curr === "member") return "UNMUTE"

  if (prev === "restricted" && curr === "restricted") {
    if (oldMember.can_send_messages && !newMember.can_send_messages) {
      return "MUTE"
    } else if (!oldMember.can_send_messages && newMember.can_send_messages) {
      return "UNMUTE"
    }
  }

  return null
}

const MAP_ACTIONS: Record<
  Exclude<ModerationAction["action"], "SILENT" | "MULTI_CHAT_SPAM"> | "BAN_ALL" | "MUTE_ALL",
  ApiInput["tg"]["auditLog"]["create"]["type"]
> = {
  MUTE: "mute",
  BAN: "ban",
  KICK: "kick",
  UNBAN: "unban",
  UNMUTE: "unmute",
  BAN_ALL: "ban_all",
  MUTE_ALL: "mute_all",
}

// TODO: missing in-channel user feedback (eg. <user> has been muted by <admin>...)
class ModerationClass<C extends Context> implements MiddlewareObj<C> {
  private composer = new Composer<C>()
  private static instance: ModerationClass<Context> | null = null
  static getInstance<C extends Context>(): ModerationClass<C> {
    if (!ModerationClass.instance) {
      ModerationClass.instance = new ModerationClass()
    }
    return ModerationClass.instance as unknown as ModerationClass<C>
  }

  middleware() {
    return this.composer.middleware()
  }

  private constructor() {
    this.composer.on("chat_member", async (ctx) => {
      const { chat, from: admin, new_chat_member, old_chat_member } = ctx.chatMember
      if (admin.id === ctx.me.id) return

      const actionType = deduceModerationAction(old_chat_member, new_chat_member)
      if (!actionType) return

      const moderationAction = {
        action: actionType,
        from: admin,
        target: new_chat_member.user,
        chat,
        reason: "Manual action via Telegram UI",
      } as ModerationAction

      if (
        (moderationAction.action === "BAN" || moderationAction.action === "MUTE") &&
        "until_date" in new_chat_member &&
        new_chat_member.until_date
      ) {
        moderationAction.duration = duration.fromUntilDate(new_chat_member.until_date)
      }

      await withSpan("bot.moderation.action", this.actionModerationAttributes(moderationAction), async (span) => {
        span.addEvent("moderation.detected", {
          source: "telegram_ui",
        })
        await this.post(moderationAction, null, span)
        span.setAttribute(BotAttributes.MODERATION_RESULT, "logged")
      })
    })
  }

  private actionModerationAttributes(p: ModerationAction) {
    const attributes: Record<string, string | number> = {
      [BotAttributes.IMPORTANCE]: "high",
      [BotAttributes.MODERATION_ACTION]: p.action,
      [BotAttributes.CHAT_ID]: p.chat.id,
      [BotAttributes.MODERATION_MODERATOR_ID]: p.from.id,
      [BotAttributes.MODERATION_TARGET_ID]: p.target.id,
    }
    if ("reason" in p && p.reason) attributes[BotAttributes.MODERATION_REASON] = p.reason
    if (p.action === "MULTI_CHAT_SPAM") attributes[BotAttributes.MESSAGE_COUNT] = p.messages.length
    return attributes
  }

  private deleteModerationAttributes(messages: Message[], executor: User, reason: string) {
    const chatIds = new Set(messages.map((message) => message.chat.id))
    const targetIds = new Set(messages.flatMap((message) => (message.from ? [message.from.id] : [])))
    const attributes: Record<string, string | number> = {
      [BotAttributes.IMPORTANCE]: "high",
      [BotAttributes.MODERATION_ACTION]: "DELETE",
      [BotAttributes.MODERATION_MODERATOR_ID]: executor.id,
      [BotAttributes.MODERATION_REASON]: reason,
      [BotAttributes.MESSAGE_COUNT]: messages.length,
      [BotAttributes.MODERATION_CHAT_COUNT]: chatIds.size,
      [BotAttributes.MODERATION_TARGET_COUNT]: targetIds.size,
    }

    if (chatIds.size === 1) {
      const [chatId] = chatIds
      if (chatId !== undefined) attributes[BotAttributes.CHAT_ID] = chatId
    }

    if (targetIds.size === 1) {
      const [targetId] = targetIds
      if (targetId !== undefined) attributes[BotAttributes.MODERATION_TARGET_ID] = targetId
    }

    return attributes
  }

  private getModerationError(p: ModerationAction, code: ModerationErrorCode): ModerationError {
    // biome-ignore lint/nursery/noUnnecessaryConditions: lying
    switch (code) {
      case "CANNOT_MOD_BOT":
        return {
          code,
          fmtError: fmt(({ b }) => b`@${p.from.username} you cannot moderate the bot!`),
          strError: "You cannot moderate the bot",
        }
      case "CANNOT_MOD_YOURSELF":
        return {
          code,
          fmtError: fmt(({ b }) => b`@${p.from.username} you cannot moderate yourself (smh)`),
          strError: "You cannot moderate yourself",
        }
      case "CANNOT_MOD_GROUPADMIN":
        return {
          code,
          fmtError: fmt(
            ({ b }) => b`@${p.from.username} the user ${fmtUser(p.target)} is a group admin and cannot be moderated`
          ),
          strError: "You cannot moderate a group admin",
        }
      case "PERFORM_ERROR":
        return {
          code,
          fmtError: fmt(() => "TG: Cannot perform the moderation action"),
          strError: "There was an error performing the moderation action",
        }
    }
  }

  private async checkTargetValid(p: ModerationAction): Promise<Result<void, ModerationErrorCode>> {
    if (p.target.id === p.from.id) return err("CANNOT_MOD_YOURSELF")
    if (p.target.id === modules.shared.botInfo.id) return err("CANNOT_MOD_BOT")

    const chatMember = await modules.shared.api.getChatMember(p.chat.id, p.target.id).catch(() => null)
    if (chatMember?.status === "administrator" || chatMember?.status === "creator") return err("CANNOT_MOD_GROUPADMIN")

    return ok()
  }

  private async audit(p: ModerationAction) {
    if (p.action === "SILENT" || p.action === "MULTI_CHAT_SPAM") return

    await api.tg.auditLog.create.mutate({
      adminId: p.from.id,
      groupId: p.chat.id,
      targetId: p.target.id,
      type: MAP_ACTIONS[p.action],
      until: "duration" in p && p.duration ? p.duration.date : null,
      reason: "reason" in p ? p.reason : undefined,
    })
  }

  private async perform(p: ModerationAction) {
    switch (p.action) {
      case "SILENT":
        return true
      case "KICK":
        return modules.shared.api
          .banChatMember(p.chat.id, p.target.id, {
            until_date: Date.now() / 1000 + duration.values.m,
          })
          .catch((error) => {
            recordException(error)
            return false
          })
      case "BAN":
        return modules.shared.api
          .banChatMember(p.chat.id, p.target.id, {
            until_date: p.duration?.timestamp_s,
          })
          .catch((error) => {
            recordException(error)
            return false
          })
      case "UNBAN":
        return modules.shared.api.unbanChatMember(p.chat.id, p.target.id).catch((error) => {
          recordException(error)
          return false
        })
      case "MUTE":
        return modules.shared.api
          .restrictChatMember(p.chat.id, p.target.id, RestrictPermissions.mute, {
            until_date: p.duration?.timestamp_s,
          })
          .catch((error) => {
            recordException(error)
            return false
          })
      case "UNMUTE":
        return modules.shared.api
          .restrictChatMember(p.chat.id, p.target.id, RestrictPermissions.unmute)
          .catch((error) => {
            recordException(error)
            return false
          })
      case "MULTI_CHAT_SPAM":
        return Promise.all(
          groupMessagesByChat(p.messages)
            .keys()
            .map((chatId) =>
              modules.shared.api
                .restrictChatMember(chatId, p.target.id, RestrictPermissions.mute, {
                  until_date: p.duration.timestamp_s,
                })
                .catch((error) => {
                  recordException(error)
                  return false
                })
            )
        ).then((res) => res.every((r) => r))
    }
  }

  private async post(p: ModerationAction, preDeleteRes: PreDeleteResult | null, span: Span) {
    const results = await Promise.allSettled([
      modules.get("tgLogger").moderationAction({
        ...p,
        preDeleteRes: preDeleteRes,
      }),
      this.audit(p),
    ])

    const rejected = results.filter((result) => result.status === "rejected")
    if (rejected.length > 0) {
      span.addEvent("moderation.post_failed", {
        rejected_count: rejected.length,
      })
      for (const result of rejected) {
        recordException(result.reason)
      }
      return
    }

    span.addEvent("moderation.post_logged")
  }

  public async deleteMessages(
    messages: Message[],
    executor: User,
    reason: string
  ): Promise<Result<PreDeleteResult | null, "DELETE_ERROR" | "NOT_FOUND">> {
    if (messages.length === 0) return ok(null)
    return await withSpan(
      "bot.moderation.delete",
      this.deleteModerationAttributes(messages, executor, reason),
      async (span) => {
        const tgLogger = modules.get("tgLogger")
        const preRes = await tgLogger.preDelete(messages, reason, executor)
        if (preRes === null || preRes.count === 0) {
          span.setAttribute(BotAttributes.MODERATION_RESULT, "not_found")
          span.addEvent("moderation.delete_not_found")
          return err("NOT_FOUND")
        }

        let delCount = 0
        for (const [chatId, mIds] of groupMessagesByChat(messages)) {
          const delOk = await modules.shared.api.deleteMessages(chatId, mIds).catch((error) => {
            recordException(error)
            return false
          })
          if (delOk) delCount += mIds.length
        }

        if (delCount === 0) {
          recordException(new Error("[Moderation:deleteMessages] no message(s) could be deleted"))
          span.setAttribute(BotAttributes.MODERATION_RESULT, "failed")
          span.setAttribute(BotAttributes.MODERATION_ERROR_CODE, "DELETE_ERROR")
          span.addEvent("moderation.delete_failed", {
            forwarded_count: preRes.count,
            deleted_count: delCount,
          })
          logger.error(
            { initialMessages: messages, executor, forwardedCount: preRes.count, deletedCount: 0 },
            "[Moderation:deleteMessages] no message(s) could be deleted"
          )
          void modules.shared.api.deleteMessages(tgLogger.groupId, preRes.logMessageIds)
          return err("DELETE_ERROR")
        }

        if (delCount / preRes.count < 0.2) {
          span.addEvent("moderation.delete_partial", {
            forwarded_count: preRes.count,
            deleted_count: delCount,
          })
          logger.warn(
            {
              initialMessages: messages,
              executor,
              forwardedCount: preRes.count,
              deletedCount: delCount,
              deletedPercentage: (delCount / preRes.count).toFixed(3),
            },
            "[Moderation:deleteMessages] delete count is much lower than forwarded count"
          )
        }

        span.setAttribute(BotAttributes.MODERATION_RESULT, "applied")
        span.addEvent("moderation.delete_completed", {
          forwarded_count: preRes.count,
          deleted_count: delCount,
        })
        return ok(preRes)
      }
    )
  }

  private async moderate(p: ModerationAction, messagesToDelete?: Message[]): Promise<Result<void, ModerationError>> {
    return await withSpan("bot.moderation.action", this.actionModerationAttributes(p), async (span) => {
      const check = await this.checkTargetValid(p)
      if (check.isErr()) {
        span.setAttribute(BotAttributes.MODERATION_RESULT, "rejected")
        span.setAttribute(BotAttributes.MODERATION_ERROR_CODE, check.error)
        span.addEvent("moderation.rejected", {
          error_code: check.error,
        })
        return err(this.getModerationError(p, check.error))
      }

      const preDeleteRes =
        messagesToDelete !== undefined
          ? await this.deleteMessages(
              messagesToDelete,
              p.from,
              `${p.action}${"reason" in p && p.reason ? ` -- ${p.reason}` : ""}`
            )
          : ok(null)

      if (preDeleteRes.isErr()) {
        span.addEvent("moderation.delete_result", {
          result: preDeleteRes.error,
        })
      } else if (preDeleteRes.value) {
        span.addEvent("moderation.delete_result", {
          result: "applied",
          deleted_count: preDeleteRes.value.count,
        })
      }

      const performOk = await this.perform(p)
      if (!performOk) {
        span.setAttribute(BotAttributes.MODERATION_RESULT, "failed")
        span.setAttribute(BotAttributes.MODERATION_ERROR_CODE, "PERFORM_ERROR")
        span.addEvent("moderation.perform_failed", {
          error_code: "PERFORM_ERROR",
        })
        return err(this.getModerationError(p, "PERFORM_ERROR"))
      }

      span.addEvent("moderation.performed")
      await this.post(p, preDeleteRes.unwrapOr(null), span)
      span.setAttribute(BotAttributes.MODERATION_RESULT, "applied")
      return ok()
    })
  }

  public async ban(
    target: User,
    chat: Chat,
    moderator: User,
    duration: Duration | null,
    messagesToDelete?: Message[],
    reason?: string
  ): Promise<Result<void, ModerationError>> {
    return await this.moderate(
      { action: "BAN", from: moderator, target, chat, duration: duration ?? undefined, reason },
      messagesToDelete
    )
  }

  public async unban(target: User, chat: Chat, moderator: User): Promise<Result<void, ModerationError>> {
    return await this.moderate({ action: "UNBAN", from: moderator, target, chat })
  }

  public async mute(
    target: User,
    chat: Chat,
    moderator: User,
    duration: Duration | null,
    messagesToDelete?: Message[],
    reason?: string
  ): Promise<Result<void, ModerationError>> {
    return await this.moderate(
      { action: "MUTE", from: moderator, target, chat, duration: duration ?? undefined, reason },
      messagesToDelete
    )
  }

  public async unmute(target: User, chat: Chat, moderator: User): Promise<Result<void, ModerationError>> {
    return await this.moderate({ action: "UNMUTE", from: moderator, target, chat })
  }

  public async kick(
    target: User,
    chat: Chat,
    moderator: User,
    messagesToDelete?: Message[],
    reason?: string
  ): Promise<Result<void, ModerationError>> {
    return await this.moderate({ action: "KICK", from: moderator, target, chat, reason }, messagesToDelete)
  }

  public async multiChatSpam(
    target: User,
    messagesToDelete: Message[],
    duration: Duration
  ): Promise<Result<void, ModerationError>> {
    if (messagesToDelete.length === 0)
      throw new Error("[Moderation:multiChatSpam] passed an empty messagesToDelete array")

    return await this.moderate(
      {
        action: "MULTI_CHAT_SPAM",
        from: modules.shared.botInfo,
        target,
        messages: messagesToDelete,
        duration,
        chat: messagesToDelete[0].chat,
      },
      messagesToDelete
    )
  }
}

export const Moderation = ModerationClass.getInstance()
