import type { Context } from "@/lib/managed-commands"
import type { MiddlewareFn } from "grammy"
import type { ChatMemberUpdated } from "grammy/types"

import { tgLogger } from "@/bot"
import { logger } from "@/logger"

/**
 * Middleware to track administrative actions performed via Telegram UI
 * (not via bot commands) such as bans, mutes, kicks done through right-click menus
 * or admin panels.
 */
export class UIAdminActionsTracker {
  private commandActionUsers = new Set<string>()

  /**
   * Mark that a command-based action is in progress for a user
   * to avoid double-logging the same action
   */
  markCommandAction(chatId: number, userId: number): void {
    const key = `${chatId}:${userId}`
    this.commandActionUsers.add(key)
    
    // Auto-cleanup after 5 seconds to prevent memory leaks
    setTimeout(() => {
      this.commandActionUsers.delete(key)
    }, 5000)
  }

  private isCommandAction(chatId: number, userId: number): boolean {
    const key = `${chatId}:${userId}`
    return this.commandActionUsers.has(key)
  }

  private async handleChatMemberUpdate(update: ChatMemberUpdated): Promise<void> {
    try {
      const { chat, from, new_chat_member, old_chat_member } = update

      // Skip if this action was triggered by a bot command
      if (this.isCommandAction(chat.id, new_chat_member.user.id)) {
        logger.debug(`Skipping UI action log for ${new_chat_member.user.id} - was command action`)
        return
      }

      // Skip if action was performed by the bot itself
      if (from.is_bot) {
        logger.debug("Skipping UI action log - performed by bot")
        return
      }

      const target = new_chat_member.user
      const admin = from

      // Detect ban vs kick (status changed to "kicked")
      if (old_chat_member.status !== "kicked" && new_chat_member.status === "kicked") {
        if (this.isKick(new_chat_member, old_chat_member)) {
          logger.info(`UI Kick detected: ${target.username || target.id} in ${chat.title}`)
          await tgLogger.adminAction({
            type: "KICK",
            from: admin,
            target,
            chat,
          })
        } else {
          logger.info(`UI Ban detected: ${target.username || target.id} in ${chat.title}`)
          await tgLogger.adminAction({
            type: "BAN",
            from: admin,
            target,
            chat,
            // For UI actions, we can't determine duration or reason
          })
        }
        return
      }

      // Detect unban (status changed from "kicked" to something else)
      if (old_chat_member.status === "kicked" && new_chat_member.status !== "kicked") {
        logger.info(`UI Unban detected: ${target.username || target.id} in ${chat.title}`)
        await tgLogger.adminAction({
          type: "UNBAN",
          from: admin,
          target,
          chat,
        })
        return
      }

      // Detect mute (permissions restricted)
      if (this.isMuted(old_chat_member) !== this.isMuted(new_chat_member)) {
        if (this.isMuted(new_chat_member)) {
          logger.info(`UI Mute detected: ${target.username || target.id} in ${chat.title}`)
          await tgLogger.adminAction({
            type: "MUTE",
            from: admin,
            target,
            chat,
          })
        } else {
          logger.info(`UI Unmute detected: ${target.username || target.id} in ${chat.title}`)
          await tgLogger.adminAction({
            type: "UNMUTE",
            from: admin,
            target,
            chat,
          })
        }
        return
      }

      // Note: Kick detection is tricky because kicks look like temporary bans
      // We'd need to track if the ban expires quickly, but that's complex
      // For now, we'll treat short-term kicks as bans which is acceptable

    } catch (error) {
      logger.error({ error, update }, "Error handling UI admin action")
    }
  }

  /**
   * Check if a chat member is muted (has restricted permissions)
   */
  private isMuted(member: any): boolean {
    if (member.status !== "restricted") return false
    
    // A user is considered muted if they can't send messages
    return !member.can_send_messages
  }

  /**
   * Check if member status represents a kick (temporary ban that expires soon)
   */
  private isKick(member: any, previousMember: any): boolean {
    // Kicks in Telegram are implemented as temporary bans
    // We can detect this by checking if:
    // 1. User was banned (status = "kicked")
    // 2. Ban has a short expiration time (< 2 minutes)
    // However, Telegram API doesn't provide the until_date in chat_member updates
    // So we'll treat all short-term status changes from non-kicked to kicked as potential kicks
    return (
      previousMember.status !== "kicked" && 
      member.status === "kicked" &&
      member.until_date && 
      member.until_date < Math.floor(Date.now() / 1000) + 120 // expires within 2 minutes
    ) || false
  }

  middleware: MiddlewareFn<Context> = async (ctx, next) => {
    // Handle chat member updates
    if (ctx.update && "my_chat_member" in ctx.update && ctx.update.my_chat_member) {
      await this.handleChatMemberUpdate(ctx.update.my_chat_member)
    } else if (ctx.update && "chat_member" in ctx.update && ctx.update.chat_member) {
      await this.handleChatMemberUpdate(ctx.update.chat_member)
    }

    return next()
  }
}