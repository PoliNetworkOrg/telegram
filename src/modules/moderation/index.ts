import type { Chat, Message, User } from "grammy/types"
import { err, ok, type Result } from "neverthrow"
import { type ApiInput, api } from "@/backend"
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

class ModerationClass {
  private static instance: ModerationClass | null = null
  static getInstance(): ModerationClass {
    if (!ModerationClass.instance) {
      ModerationClass.instance = new ModerationClass()
    }
    return ModerationClass.instance
  }

  private constructor() {}

  private async checkTargetValid(p: ModerationAction): Promise<Result<void, string>> {
    if (p.target.id === p.from.id) return err(fmt(({ b }) => b`@${p.from.username} you cannot moderate yourself (smh)`))
    if (p.target.id === modules.shared.botInfo.id)
      return err(fmt(({ b }) => b`@${p.from.username} you cannot moderate the bot!`))

    const chatMember = await modules.shared.api.getChatMember(p.chat.id, p.target.id).catch(() => null)
    if (chatMember?.status === "administrator" || chatMember?.status === "creator")
      return err(
        fmt(({ b }) => b`@${p.from.username} the user ${fmtUser(p.target)} is a group admin and cannot be moderated`)
      )

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
  ): Promise<Result<PreDeleteResult | null, "DELETE_ERROR">> {
    if (messages.length === 0) return ok(null)
    const preRes = await modules.get("tgLogger").preDelete(messages, reason, executor)

    for (const [chatId, mIds] of groupMessagesByChat(messages)) {
      const res = await modules.shared.api.deleteMessages(chatId, mIds).catch(() => false)
      if (!res) {
        // TODO: delete preRes messages
        return err("DELETE_ERROR")
      }
    }

    return ok(preRes)
  }

  private async moderate(p: ModerationAction, messagesToDelete?: Message[]): Promise<Result<void, string>> {
    const check = await this.checkTargetValid(p)
    if (check.isErr()) return check

    const preDeleteRes =
      messagesToDelete !== undefined
        ? await this.deleteMessages(
            messagesToDelete,
            p.from,
            `${p.action}${"reason" in p && p.reason ? ` -- ${p.reason}` : ""}`
          )
        : null

    const performOk = await this.perform(p)
    if (!performOk) return err("TG: Cannot perform the moderation action") // TODO: make the perform output a Result

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
  ): Promise<Result<void, string>> {
    return await this.moderate(
      { action: "BAN", from: moderator, target, chat, duration: duration ?? undefined, reason },
      messagesToDelete
    )
  }

  public async unban(target: User, chat: Chat, moderator: User): Promise<Result<void, string>> {
    return await this.moderate({ action: "UNBAN", from: moderator, target, chat })
  }

  public async mute(
    target: User,
    chat: Chat,
    moderator: User,
    duration: Duration | null,
    messagesToDelete?: Message[],
    reason?: string
  ): Promise<Result<void, string>> {
    return await this.moderate(
      { action: "MUTE", from: moderator, target, chat, duration: duration ?? undefined, reason },
      messagesToDelete
    )
  }

  public async unmute(target: User, chat: Chat, moderator: User): Promise<Result<void, string>> {
    return await this.moderate({ action: "UNMUTE", from: moderator, target, chat })
  }

  public async kick(
    target: User,
    chat: Chat,
    moderator: User,
    messagesToDelete?: Message[],
    reason?: string
  ): Promise<Result<void, string>> {
    return await this.moderate({ action: "KICK", from: moderator, target, chat, reason }, messagesToDelete)
  }

  public async multiChatSpam(target: User, messagesToDelete: Message[], duration: Duration) {
    if (messagesToDelete.length === 0) return err("Sei stupido")

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
