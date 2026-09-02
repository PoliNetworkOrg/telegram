import { Composer, type Context, type MiddlewareObj } from "grammy"
import type { Chat, ChatMember, Message, User } from "grammy/types"
import { err, ok, type Result } from "neverthrow"
import { api } from "@/backend"
import { logger } from "@/logger"
import { MessageUserStorage } from "@/middlewares/message-user-storage"
import { groupMessagesByChat, RestrictPermissions } from "@/utils/chat"
import { type Duration, duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { modules } from ".."
import { backendModerationLog, type ModerationAuditStatus, type ModerationAuditType } from "./backend-log"
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

const MAP_ACTIONS: Record<Exclude<ModerationAction["action"], "SILENT">, ModerationAuditType> = {
  MUTE: "mute",
  BAN: "ban",
  KICK: "kick",
  UNBAN: "unban",
  UNMUTE: "unmute",
  MULTI_CHAT_SPAM: "multi_chat_spam",
}

type ModerationOutcome = {
  successful: boolean
  status: ModerationAuditStatus
  deletedMessageCount: number | null
  totalGroupCount: number
  successGroupCount: number
  failedGroupCount: number
  successfulGroupIds?: number[]
}

type RecentMessageDeletionOutcome = {
  deletedMessageCount: number | null
  telegramDeletionSucceeded: boolean
}

function outcome(successful: boolean, deletedMessageCount: number | null = 0): ModerationOutcome {
  return {
    successful,
    status: successful ? "completed" : "failed",
    deletedMessageCount,
    totalGroupCount: 0,
    successGroupCount: 0,
    failedGroupCount: 0,
  }
}

function addDeletionCounts(...counts: (number | null | undefined)[]): number | null {
  return counts.includes(null) ? null : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
}

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

      await this.post(moderationAction, null)
    })
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

  private async audit(p: ModerationAction, deleteResult: PreDeleteResult | null, result: ModerationOutcome) {
    if (p.action === "SILENT") return

    await backendModerationLog.create({
      adminId: p.from.id,
      groupId: p.action === "MULTI_CHAT_SPAM" ? null : p.chat.id,
      targetId: p.target.id,
      type: MAP_ACTIONS[p.action],
      until: "duration" in p && p.duration ? p.duration.date : null,
      reason: "reason" in p ? p.reason : undefined,
      deletedMessageCount: addDeletionCounts(deleteResult?.recentMessageCount, result.deletedMessageCount),
      status: result.status,
      totalGroupCount: result.totalGroupCount,
      successGroupCount: result.successGroupCount,
      failedGroupCount: result.failedGroupCount,
    })
  }

  /**
   * Mass deletes the last 100 messages of a user in a specific chat, on best effort basis.
   *
   * Used when banning a user to delete all their messages in the chat
   */
  public async deleteAllLastMessages(
    userId: number,
    chatId: number,
    options: { requireSuccess?: boolean } = {}
  ): Promise<number | null> {
    const result = await this.deleteAllLastMessagesWithOutcome(userId, chatId, options)
    return result.deletedMessageCount
  }

  private async deleteAllLastMessagesWithOutcome(
    userId: number,
    chatId: number,
    options: { requireSuccess?: boolean } = {}
  ): Promise<RecentMessageDeletionOutcome> {
    const fail = (error: unknown, message: string, messagesCount?: number) => {
      logger.warn({ error, userId, chatId, messagesCount }, message)
      if (options.requireSuccess) throw error
    }

    try {
      await MessageUserStorage.getInstance().syncMessages()
    } catch (error) {
      fail(error, "[Moderation:deleteAllLastMessages] failed to flush stored messages")
      return { deletedMessageCount: null, telegramDeletionSucceeded: false }
    }

    // both the limit of tRPC endpoint and Telegram API hard limit: https://core.telegram.org/bots/api#deletemessages
    let response: Awaited<ReturnType<typeof api.tg.messages.getLastByUser.query>>
    try {
      response = await api.tg.messages.getLastByUser.query({ userId, chatId, limit: 100 })
    } catch (error) {
      fail(error, "[Moderation:deleteAllLastMessages] failed to load stored messages")
      return { deletedMessageCount: null, telegramDeletionSucceeded: false }
    }

    if (response.error) {
      if (response.error === "NOT_FOUND") return { deletedMessageCount: 0, telegramDeletionSucceeded: false }

      const error = new Error(`Backend returned ${response.error}`)
      fail(error, "[Moderation:deleteAllLastMessages] failed to load stored messages")
      return { deletedMessageCount: null, telegramDeletionSucceeded: false }
    }

    const messageIds = response.messages
      .filter((message) => !("deletedAt" in message) || !message.deletedAt)
      .map((message) => message.messageId)
    if (messageIds.length === 0) return { deletedMessageCount: 0, telegramDeletionSucceeded: false }

    try {
      const deleted = await modules.shared.api.deleteMessages(chatId, messageIds)
      if (!deleted) throw new Error("Telegram did not delete the stored messages")
    } catch (error) {
      fail(error, "[Moderation:deleteAllLastMessages] failed to delete stored messages", messageIds.length)
      return { deletedMessageCount: null, telegramDeletionSucceeded: false }
    }

    try {
      return {
        deletedMessageCount: await backendModerationLog.markMessagesDeleted(chatId, messageIds),
        telegramDeletionSucceeded: true,
      }
    } catch (error) {
      logger.warn({ error, userId, chatId, messageIds }, "[Moderation:deleteAllLastMessages] failed to mark messages")
      return { deletedMessageCount: null, telegramDeletionSucceeded: true }
    }
  }

  private async perform(p: ModerationAction): Promise<ModerationOutcome> {
    switch (p.action) {
      case "SILENT":
        return outcome(true)
      case "KICK": {
        const successful = await modules.shared.api
          .banChatMember(p.chat.id, p.target.id, {
            until_date: Date.now() / 1000 + duration.values.m,
            revoke_messages: true,
          })
          .catch(() => false)
        return outcome(successful)
      }
      case "BAN": {
        const [successful, deletion] = await Promise.all([
          modules.shared.api
            .banChatMember(p.chat.id, p.target.id, { until_date: p.duration?.timestamp_s })
            .catch(() => false),
          this.deleteAllLastMessagesWithOutcome(p.target.id, p.chat.id),
        ])
        const result = outcome(successful, deletion.deletedMessageCount)
        const cleanupHadEffect = deletion.telegramDeletionSucceeded || (deletion.deletedMessageCount ?? 0) > 0
        if ((successful && deletion.deletedMessageCount === null) || (!successful && cleanupHadEffect)) {
          result.status = "partial"
        }
        return result
      }

      case "UNBAN": {
        const successful = await modules.shared.api
          .unbanChatMember(p.chat.id, p.target.id, { only_if_banned: true })
          .catch(() => false)
        return outcome(successful)
      }
      case "MUTE": {
        const successful = await modules.shared.api
          .restrictChatMember(p.chat.id, p.target.id, RestrictPermissions.mute, {
            until_date: p.duration?.timestamp_s,
          })
          .catch(() => false)
        return outcome(successful)
      }
      case "UNMUTE": {
        const successful = await modules.shared.api
          .restrictChatMember(p.chat.id, p.target.id, RestrictPermissions.unmute)
          .catch(() => false)
        return outcome(successful)
      }
      case "MULTI_CHAT_SPAM": {
        const chatIds = [...groupMessagesByChat(p.messages).keys()]
        const results = await Promise.all(
          chatIds.map((chatId) =>
            modules.shared.api
              .restrictChatMember(chatId, p.target.id, RestrictPermissions.mute, {
                until_date: p.duration.timestamp_s,
              })
              .catch(() => false)
          )
        )
        const successGroupCount = results.filter(Boolean).length
        const failedGroupCount = results.length - successGroupCount
        return {
          successful: failedGroupCount === 0,
          status: successGroupCount === 0 ? "failed" : failedGroupCount === 0 ? "completed" : "partial",
          deletedMessageCount: 0,
          totalGroupCount: results.length,
          successGroupCount,
          failedGroupCount,
          successfulGroupIds: results.flatMap((successful, index) => (successful ? [chatIds[index]] : [])),
        }
      }
    }
  }

  private async post(p: ModerationAction, deleteResult: PreDeleteResult | null, result = outcome(true)) {
    await Promise.all([
      modules
        .get("tgLogger")
        .moderationAction({ ...p, preDeleteRes: deleteResult })
        .catch((error: unknown) => {
          logger.warn({ error, action: p.action }, "[Moderation:post] failed to write the Telegram log")
        }),
      this.audit(p, deleteResult, result).catch((error: unknown) => {
        logger.error({ error, action: p.action, targetId: p.target.id }, "[Moderation:post] failed to write audit log")
      }),
    ])
  }

  public async deleteMessages(
    messages: Message[],
    executor: User,
    reason: string,
    options: { createAudit?: boolean } = {}
  ): Promise<Result<PreDeleteResult | null, "DELETE_ERROR" | "NOT_FOUND">> {
    if (messages.length === 0) return ok(null)

    const tgLogger = modules.get("tgLogger")
    const preDeleteResult = await tgLogger.preDelete(messages, reason, executor)
    if (!preDeleteResult || preDeleteResult.count === 0) return err("NOT_FOUND")

    let telegramDeletedCount = 0
    let recentMessageCount: number | null = 0
    let successGroupCount = 0
    const successfulChatIds: number[] = []
    const messagesByChat = groupMessagesByChat(messages)
    for (const [chatId, mIds] of messagesByChat) {
      const delOk = await modules.shared.api.deleteMessages(chatId, mIds).catch(() => false)
      if (!delOk) continue

      telegramDeletedCount += mIds.length
      successGroupCount += 1
      successfulChatIds.push(chatId)
      await backendModerationLog
        .markMessagesDeleted(chatId, mIds)
        .then((markedCount) => {
          if (recentMessageCount !== null) recentMessageCount += markedCount
        })
        .catch((error: unknown) => {
          recentMessageCount = null
          logger.warn({ error, chatId, messageIds: mIds }, "[Moderation:deleteMessages] failed to mark messages")
        })
    }

    const failedGroupCount = messagesByChat.size - successGroupCount
    const status = telegramDeletedCount === 0 ? "failed" : failedGroupCount === 0 ? "completed" : "partial"
    if (options.createAudit !== false) {
      await backendModerationLog
        .create({
          adminId: executor.id,
          targetId: messages[0].from?.id ?? executor.id,
          groupId: messagesByChat.size === 1 ? (messagesByChat.keys().next().value ?? null) : null,
          type: "delete",
          until: null,
          reason,
          status,
          deletedMessageCount: recentMessageCount,
          totalGroupCount: messagesByChat.size,
          successGroupCount,
          failedGroupCount,
        })
        .catch((error: unknown) => {
          logger.error({ error, executor, reason }, "[Moderation:deleteMessages] failed to write audit log")
        })
    }

    if (telegramDeletedCount === 0) {
      logger.error(
        { initialMessages: messages, executor, forwardedCount: preDeleteResult.count, deletedCount: 0 },
        "[Moderation:deleteMessages] no message(s) could be deleted"
      )
      void modules.shared.api.deleteMessages(tgLogger.groupId, preDeleteResult.logMessageIds)
      return err("DELETE_ERROR")
    }

    if (telegramDeletedCount / preDeleteResult.count < 0.2) {
      logger.warn(
        {
          initialMessages: messages,
          executor,
          forwardedCount: preDeleteResult.count,
          deletedCount: telegramDeletedCount,
          deletedPercentage: (telegramDeletedCount / preDeleteResult.count).toFixed(3),
        },
        "[Moderation:deleteMessages] delete count is much lower than forwarded count"
      )
    }

    return ok({
      ...preDeleteResult,
      recentMessageCount,
      successfulChatIds,
      failedChatIds: [...messagesByChat.keys()].filter((chatId) => !successfulChatIds.includes(chatId)),
    })
  }

  private async moderate(p: ModerationAction, messagesToDelete?: Message[]): Promise<Result<void, ModerationError>> {
    const check = await this.checkTargetValid(p)
    if (check.isErr()) return err(this.getModerationError(p, check.error))

    const deleteResult =
      messagesToDelete !== undefined
        ? await this.deleteMessages(
            messagesToDelete,
            p.from,
            `${p.action}${"reason" in p && p.reason ? ` -- ${p.reason}` : ""}`,
            { createAudit: false }
          )
        : ok(null)

    const result = await this.perform(p)
    const deletionSucceeded = deleteResult.isOk() && deleteResult.value !== null
    if (p.action === "MULTI_CHAT_SPAM") {
      const chatIds = [...groupMessagesByChat(p.messages).keys()]
      const mutedChatIds = new Set(result.successfulGroupIds)
      const deletedChatIds = new Set(deleteResult.isOk() ? deleteResult.value?.successfulChatIds : [])
      const successGroupCount = chatIds.filter(
        (chatId) => mutedChatIds.has(chatId) && deletedChatIds.has(chatId)
      ).length
      const anyEffect = mutedChatIds.size > 0 || deletedChatIds.size > 0
      result.totalGroupCount = chatIds.length
      result.successGroupCount = successGroupCount
      result.failedGroupCount = chatIds.length - successGroupCount
      result.status = successGroupCount === chatIds.length ? "completed" : anyEffect ? "partial" : "failed"
    } else if (messagesToDelete?.length && deletionSucceeded !== result.successful) {
      result.status = "partial"
    }

    if (!result.successful) {
      await this.audit(p, deleteResult.unwrapOr(null), result).catch((error: unknown) => {
        logger.error(
          { error, action: p.action, targetId: p.target.id },
          "[Moderation:moderate] failed to write audit log"
        )
      })
      return err(this.getModerationError(p, "PERFORM_ERROR"))
    }

    await this.post(p, deleteResult.unwrapOr(null), result)
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
