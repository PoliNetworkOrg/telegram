import { Composer, type MiddlewareFn, type MiddlewareObj } from "grammy"
import { tgLogger } from "@/bot"
import { duration } from "@/utils/duration"
import type { Context } from "@/utils/types"

/**
 * Middleware to track administrative actions performed via Telegram UI (not via bot commands).
 * Supported actions: ban/unban, mute/unmute
 *
 * LIMITATIONS: (TO CHECK)
 * - Telegram Bot API doesn't provide deletion events.
 * - Duration/reason detection: UI actions don't include duration or reason
 *   information in the chat_member updates.
 *   Note: For message deletion detection, consider enabling admin permissions
 *   for the bot or implementing a separate system.
 */

export class UIActionsLogger<C extends Context> implements MiddlewareObj<C> {
  private composer = new Composer<C>()

  constructor() {
    this.composer.on("chat_member", async (ctx) => {
      const { chat, from: admin, new_chat_member, old_chat_member } = ctx.chatMember
      if (admin.id === ctx.me.id) return

      const prev = old_chat_member.status
      const curr = new_chat_member.status
      const target = new_chat_member.user
      if (prev === "left" && curr === "member") return // skip join event
      if (prev === "member" && curr === "left") return // skip left event

      if (prev === "kicked" && curr === "left") {
        await tgLogger.moderationAction({
          action: "UNBAN",
          from: admin,
          target,
          chat,
        })
        return
      }

      if (prev === "member" && curr === "kicked") {
        await tgLogger.moderationAction({
          action: "BAN",
          from: admin,
          target,
          chat,
        })
        return
      }

      if (prev === "member" && curr === "restricted" && !new_chat_member.can_send_messages) {
        await tgLogger.moderationAction({
          action: "MUTE",
          duration: duration.fromUntilDate(new_chat_member.until_date),
          from: admin,
          target,
          chat,
        })
        return
      }

      if (prev === "restricted" && curr === "restricted") {
        if (old_chat_member.can_send_messages && !new_chat_member.can_send_messages) {
          // mute
          await tgLogger.moderationAction({
            action: "MUTE",
            duration: duration.fromUntilDate(new_chat_member.until_date),
            from: admin,
            target,
            chat,
          })
        } else if (!old_chat_member.can_send_messages && new_chat_member.can_send_messages) {
          await tgLogger.moderationAction({
            action: "UNMUTE",
            from: admin,
            target,
            chat,
          })
        }
        return
      }

      if (prev === "restricted" && curr === "member") {
        await tgLogger.moderationAction({
          action: "UNMUTE",
          from: admin,
          target,
          chat,
        })
        return
      }
    })
  }

  middleware(): MiddlewareFn<C> {
    return this.composer.middleware()
  }
}
