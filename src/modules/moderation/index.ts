import { Composer, type Context, type MiddlewareObj } from "grammy"
import type { Chat, ChatMember, Message, User } from "grammy/types"
import { err, ok, type Result } from "neverthrow"
import { type ApiInput, api } from "@/backend"
import { logger } from "@/logger"
import { MessageUserStorage } from "@/middlewares/message-user-storage"
import { groupMessagesByChat, RestrictPermissions } from "@/utils/chat"
import { type Duration, duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { modules } from ".."
import type { ModerationAction, ModerationError, ModerationErrorCode, PreDeleteResult } from "./types"

class ModerationClass<C extends Context> implements MiddlewareObj<C> {
  private composer = new Composer<C>()
  private static instance: ModerationClass<Context> | null = null



  /**
   * Get the singleton moderation middleware instance.
   *
   * @returns The shared ModerationClass instance.
   */
  static getInstance<C extends Context>(): ModerationClass<C> {
    if (!ModerationClass.instance) {
      ModerationClass.instance = new ModerationClass()
    }
    return ModerationClass.instance as unknown as ModerationClass<C>
  }

  /**
   * Expose the moderation middleware for use by the bot.
   *
   * @returns The composed middleware object.
   */
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

  // =========================================================================
  // PUBLIC MODERATION API (Interface Methods)
  // =========================================================================

  /**
   * Ban a user from the chat.
   *
   * @param target The user to ban.
   * @param chat The chat where the ban occurs.
   * @param moderator The moderator performing the ban.
   * @param duration Optional ban duration.
   * @param messagesToDelete Optional messages to delete before banning.
   * @param reason Optional reason for the ban.
   * @returns Result indicating success or a moderation error.
   */
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

  // =========================================================================
  // CORE ORCHESTRATION PIPELINE
  // =========================================================================

  /**
   * Run a moderation action, including validation, optional message deletion, execution, and post-processing.
   *
   * @param p The moderation action to apply.
   * @param messagesToDelete Optional messages to delete before the action.
   * @returns Ok when the moderation completed, or an error when it failed.
   */
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
        : ok(null)

    const performOk = await this.perform(p)
    if (!performOk) return err(this.getModerationError(p, "PERFORM_ERROR")) // TODO: make the perform output a Result

    await this.post(p, preDeleteRes.unwrapOr(null))

    return ok()
  }

  /**
   * Validate that a moderation target can be moderated.
   *
   * @param p The moderation action to validate.
   * @returns Ok when valid, or an error code when invalid.
   */
  private async checkTargetValid(p: ModerationAction): Promise<Result<void, ModerationErrorCode>> {

    if (p.target.id === p.from.id) return err("CANNOT_MOD_YOURSELF")
    if (p.target.id === modules.shared.botInfo.id) return err("CANNOT_MOD_BOT")

    const chatMember = await modules.shared.api.getChatMember(p.chat.id, p.target.id).catch(() => null)
    if (chatMember?.status === "administrator" || chatMember?.status === "creator") return err("CANNOT_MOD_GROUPADMIN")

    return ok()
  }

  /**
   * Delete the provided messages and log the deletion in the moderation logger.
   *
   * @param messages The messages to delete.
   * @param executor The user who requested the deletion.
   * @param reason The reason for deleting the messages.
   * @returns A result containing the pre-delete metadata or an error code.
   */
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
      const delOk = await modules.shared.api.deleteMessages(chatId, mIds).catch(() => false)
      if (delOk) delCount += mIds.length
    }

    if (delCount === 0) {
      logger.error(
        { initialMessages: messages, executor, forwardedCount: preRes.count, deletedCount: 0 },
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
          forwardedCount: preRes.count,
          deletedCount: delCount,
          deletedPercentage: (delCount / preRes.count).toFixed(3),
        },
        "[Moderation:deleteMessages] delete count is much lower than forwarded count"
      )
    }

    return ok(preRes)
  }

  /**
   * Mass deletes the last 100 messages of a user in a specific chat, on best effort basis.
   *
   * Used when banning a user to delete all their messages in the chat
   *
   * @param userId The ID of the user whose messages should be deleted.
   * @param chatId The chat ID where the messages are located.
   */
  public async deleteAllLastMessages(userId: number, chatId: number): Promise<void> {
    await MessageUserStorage.getInstance()
      .sync()
      .catch(() => {})

    // both the limit of tRPC endpoint and Telegram API hard limit: https://core.telegram.org/bots/api#deletemessages
    const messages = await api.tg.messages.getLastByUser
      .query({ userId, chatId, limit: 100 })
      .then((res) => res.messages ?? [])
      .catch(() => [])

    const success = await modules.shared.api
      .deleteMessages(
        chatId,
        messages.map((m) => m.messageId)
      )
      .catch(() => {})

    logger.debug(
      { userId, chatId, messagesCount: messages.length, success },
      "[Moderation:deleteAllLastMessages] deleted last messages of the user in the chat"
    )
  }

  private async kickAction(p: ModerationAction) {
    return modules.shared.api
          .banChatMember(p.chat.id, p.target.id, {
            until_date: Date.now() / 1000 + duration.values.m,
            revoke_messages: true,
          })
          .catch(() => false)
  }

  /**
   * Perform the actual moderation action against Telegram.
   *
   * @param p The moderation action to execute.
   * @returns True when the action succeeded, false otherwise.
   */
  private async perform(p: ModerationAction) {
    switch (p.action) {
      case "SILENT":
        return true

      case "KICK":
        return await this.kickAction(p)

      case "BAN": {
        const [success] = await Promise.all([
          modules.shared.api
            .banChatMember(p.chat.id, p.target.id, { until_date: p.duration?.timestamp_s })
            .catch(() => false),
          this.deleteAllLastMessages(p.target.id, p.chat.id),
        ])
        return success
      }

      case "UNBAN":
        return modules.shared.api.unbanChatMember(p.chat.id, p.target.id, { only_if_banned: true }).catch(() => false)

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

  /**
   * Dispatch moderation notifications and audit logging after an action.
   *
   * @param p The moderation action that was executed.
   * @param preDeleteRes The result of any pre-delete operation, or null.
   */
  private async post(p: ModerationAction, preDeleteRes: PreDeleteResult | null) {
    // TODO: handle errors?
    await Promise.allSettled([
      modules.get("tgLogger").moderationAction({
        ...p,
        preDeleteRes: preDeleteRes,
      }),
      this.audit(p),
    ])
  }

  /**
   * Record the moderation action in the audit log when appropriate.
   *
   * @param p The moderation action to audit.
   */
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

  /**
   * Convert a moderation error code into a user-facing moderation error payload.
   *
   * @param p The moderation action context.
   * @param code The error code to map.
   * @returns The error object containing formatted and string messages.
   */
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
}

// =========================================================================
// STATIC HELPERS & EXPORTS (Pushed to bottom to keep main logic accessible)
// =========================================================================

/**
 * Deduce a moderation action from a Telegram chat member update.
 *
 * @param oldMember The previous state of the chat member.
 * @param newMember The new state of the chat member.
 * @returns The inferred moderation action or null when no action should be logged.
 */
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

/**
 * A mapping of moderation actions to their corresponding API input types.
 */
const MAP_ACTIONS: Record<
  Exclude<ModerationAction["action"], "SILENT" | "MULTI_CHAT_SPAM"> | "BAN_ALL" | "UNBAN_ALL",
  ApiInput["tg"]["auditLog"]["create"]["type"]
> = {
  MUTE: "mute",
  BAN: "ban",
  KICK: "kick",
  UNBAN: "unban",
  UNMUTE: "unmute",
  BAN_ALL: "ban_all",
  UNBAN_ALL: "unban_all",
}

export const Moderation = ModerationClass.getInstance()
