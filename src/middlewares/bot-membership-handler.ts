import { Composer, type Filter, InlineKeyboard, type MiddlewareObj } from "grammy"
import { api } from "@/backend"
import { GroupManagement } from "@/lib/group-management"
import { logger } from "@/logger"
import { modules } from "@/modules"
import type { Context } from "@/utils/types"

type ChatType = "group" | "supergroup" | "private" | "channel"
type StatusType = "member" | "administrator" | "creator" | "restricted" | "left" | "kicked"

// if added as member, tg fires:
// group -> "member"
// supergroup -> "member"
// channel -> cannot happen
//
// if added as admin, tg fires:
// group -> "member" AND "administrator"
// supergroup -> "administrator"
// channel -> "administrator"
//
// therefore on group we only listen for "member", on channel for "administrator", on supergroup for both
// in private we never listen to this event
//
//
const joinEvent: Record<ChatType, StatusType[]> = {
  group: ["member"],
  supergroup: ["member", "administrator"],
  channel: ["administrator"],
  private: [],
}

type MemberContext<C extends Context> = Filter<C, "my_chat_member">
export class BotMembershipHandler<C extends Context> implements MiddlewareObj<C> {
  private composer = new Composer<C>()

  constructor() {
    this.composer.on("my_chat_member", async (ctx, next) => {
      const chat = ctx.myChatMember.chat
      const newStatus = ctx.myChatMember.new_chat_member.status
      if (chat.type === "private") return next()

      if (this.isJoin(ctx)) {
        // joined event
        await this.checkAdderPermission(ctx)
        return next()
      }

      if (newStatus === "administrator") {
        // promoted to admin event
        await this.createGroup(ctx)
      } else {
        // not an admin anymore (left, restricted or downgraded)
        await this.deleteGroup(ctx)
      }

      await next()
    })
  }

  middleware() {
    return this.composer.middleware()
  }

  private isJoin(ctx: MemberContext<C>): boolean {
    const oldStatusCheck = ["left", "kicked"].includes(ctx.myChatMember.old_chat_member.status)
    const newStatusCheck = joinEvent[ctx.myChatMember.chat.type].includes(ctx.myChatMember.new_chat_member.status)

    return oldStatusCheck && newStatusCheck
  }

  private async checkAdderPermission(ctx: MemberContext<C>): Promise<boolean> {
    const { allowed } = await api.tg.permissions.canAddBot.query({ userId: ctx.myChatMember.from.id })
    if (!allowed) {
      const left = await ctx.leaveChat().catch(() => false)
      if (left) {
        await modules
          .get("tgLogger")
          .groupManagement({ type: "LEAVE", chat: ctx.myChatMember.chat, addedBy: ctx.myChatMember.from })
        logger.info({ chat: ctx.myChatMember.chat, from: ctx.myChatMember.from }, `[BCE] Left unauthorized group`)
      } else {
        await modules.get("tgLogger").groupManagement({
          type: "LEAVE_FAIL",
          chat: ctx.myChatMember.chat,
          addedBy: ctx.myChatMember.from,
        })
        logger.error(
          { chat: ctx.myChatMember.chat, from: ctx.myChatMember.from },
          `[BCE] Cannot left unauthorized group`
        )
      }
    }
    return allowed
  }

  private async deleteGroup(ctx: MemberContext<C>): Promise<void> {
    const chat = ctx.myChatMember.chat
    const res = await GroupManagement.delete(chat)
    await res.match(
      async () => {
        await modules.get("tgLogger").groupManagement({ type: "DELETE", chat })
        logger.info({ chat }, `[BCE] Deleted a group`)
      },
      (e) => {
        logger.error({ chat }, `[BCE] Cannot delete group from DB. Reason: ${e}`)
      }
    )
  }

  private async createGroup(ctx: MemberContext<C>): Promise<void> {
    const chat = await ctx.getChat()
    const res = await GroupManagement.create(chat)
    await res.match(
      async (g) => {
        await modules.get("tgLogger").groupManagement({ type: "CREATE", chat, inviteLink: g.link, addedBy: ctx.from })
        logger.info({ chat }, `[BCE] Created a new group`)
      },
      async (e) => {
        const ik = new InlineKeyboard()
        if (chat.invite_link) ik.url("Join Group", chat.invite_link)
        await modules
          .get("tgLogger")
          .groupManagement({ type: "CREATE_FAIL", chat, inviteLink: chat.invite_link, reason: e })
        logger.error({ chat }, `[BCE] Cannot create group into DB. Reason: ${e}`)
      }
    )
  }
}
