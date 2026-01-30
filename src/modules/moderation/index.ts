import type { Chat, Message, User } from "grammy/types"
import { err, ok, type Result } from "neverthrow"
import { type ApiInput, api } from "@/backend"
import { logger } from "@/logger"
import { groupMessagesByChat, RestrictPermissions } from "@/utils/chat"
import { type Duration, duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { modules } from ".."
import type { ModerationAction, PreDeleteResult } from "../tg-logger/types"

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

type ModerationErrorCode = "CANNOT_MOD_YOURSELF" | "CANNOT_MOD_BOT" | "CANNOT_MOD_GROUPADMIN" | "PERFORM_ERROR"
type ModerationError = { code: ModerationErrorCode; fmtError: string; strError: string }

// TODO: missing in-channel user feedback (eg. <user> has been muted by <admin>...)
class ModerationClass {
  private static instance: ModerationClass | null = null
  static getInstance(): ModerationClass {
    if (!ModerationClass.instance) {
      ModerationClass.instance = new ModerationClass()
    }
    return ModerationClass.instance
  }

  private constructor() {}

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
          strError: "There was an error perfoming the moderation action",
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
          .catch(() => false)
      case "BAN":
        return modules.shared.api
          .banChatMember(p.chat.id, p.target.id, {
            until_date: p.duration?.timestamp_s,
          })
          .catch(() => false)
      case "UNBAN":
        return modules.shared.api.unbanChatMember(p.chat.id, p.target.id).catch(() => false)
      case "MUTE":
        return modules.shared.api
          .restrictChatMember(p.chat.id, p.target.id, RestrictPermissions.mute, {
            until_date: p.duration?.timestamp_s,
          })
          .catch(() => false)
      case "UNMUTE":
        return modules.shared.api
          .restrictChatMember(p.chat.id, p.target.id, RestrictPermissions.unmute)
          .catch(() => false)
      case "MULTI_CHAT_SPAM":
        return Promise.all(
          groupMessagesByChat(p.messages)
            .keys()
            .map((chatId) =>
              modules.shared.api
                .restrictChatMember(chatId, p.target.id, RestrictPermissions.mute, {
                  until_date: p.duration.timestamp_s,
                })
                .catch(() => false)
            )
        ).then((res) => res.every((r) => r))
    }
  }

  public async deleteMessages(
    messages: Message[],
    executor: User,
    reason: string
  ): Promise<Result<PreDeleteResult | null, "DELETE_ERROR" | "NOT_FOUND">> {
    if (messages.length === 0) return ok(null)

    const tgLogger = modules.get("tgLogger")
    const preRes = await tgLogger.preDelete(messages, reason, executor)
    if (preRes === null || preRes.count === 0) return err("NOT_FOUND")

    let delCount = 0
    for (const [chatId, mIds] of groupMessagesByChat(messages)) {
      const ok = await modules.shared.api.deleteMessages(chatId, mIds).catch(() => false)
      if (ok) delCount += mIds.length
    }

    if (delCount === 0) {
      logger.error(
        { initialMessages: messages, executor, forwaredCount: preRes.count, deletedCount: 0 },
        "[Moderation:deleteMessages] no message(s) could be deleted"
      )
      void modules.shared.api.deleteMessages(tgLogger.groupId, preRes.logMessageIds)
      return err("DELETE_ERROR")
    }

    if (delCount / preRes.count < 0.2) {
      logger.warn(
        {
          initialMessages: messages,
          executor,
          forwaredCount: preRes.count,
          deletedCount: delCount,
          deletedPercentage: (delCount / preRes.count).toFixed(3),
        },
        "[Moderation:deleteMessages] delete count is much lower than forwarded count"
      )
    }

    return ok(preRes)
  }

  private async moderate(p: ModerationAction, messagesToDelete?: Message[]): Promise<Result<void, ModerationError>> {
    const check = await this.checkTargetValid(p)
    if (check.isErr()) return err(this.getModerationError(p, check.error))

    const preDeleteRes =
      messagesToDelete !== undefined
        ? await this.deleteMessages(
            messagesToDelete,
            p.from,
            `${p.action}${"reason" in p && p.reason ? ` -- ${p.reason}` : ""}`
          )
        : null

    const performOk = await this.perform(p)
    if (!performOk) return err(this.getModerationError(p, "PERFORM_ERROR")) // TODO: make the perform output a Result

    await modules.get("tgLogger").moderationAction({
      ...p,
      preDeleteRes: preDeleteRes?.unwrapOr(null),
    })

    await this.audit(p)
    return ok()
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
