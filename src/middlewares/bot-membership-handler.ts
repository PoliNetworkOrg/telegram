import type { Filter } from "grammy"
import { GroupManagement } from "@/lib/group-management"
import { type TelemetryContextFlavor, TrackedMiddleware } from "@/modules/telemetry/middleware"
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
export class BotMembershipHandler<C extends TelemetryContextFlavor<Context>> extends TrackedMiddleware<C> {
  constructor() {
    super("bot_membership_handler")
    this.composer.on("my_chat_member", async (ctx, next) => {
      const chat = ctx.myChatMember.chat
      const newStatus = ctx.myChatMember.new_chat_member.status
      if (chat.type === "private") return next()

      if (BotMembershipHandler.isJoin(ctx)) {
        // joined event
        // go next, if adder has no permission
        if (!(await GroupManagement.checkAdderPermission(ctx.myChatMember.chat, ctx.myChatMember.from))) return next()
      }

      if (newStatus === "administrator") {
        // promoted to admin event
        await GroupManagement.create(ctx.chatId, ctx.myChatMember.from)
      } else {
        // not an admin anymore (left, restricted or downgraded)
        await GroupManagement.delete(ctx.chat)
      }

      await next()
    })
  }

  private static isJoin<C extends Context>(ctx: MemberContext<C>): boolean {
    const oldStatusCheck = ["left", "kicked"].includes(ctx.myChatMember.old_chat_member.status)
    const newStatusCheck = joinEvent[ctx.myChatMember.chat.type].includes(ctx.myChatMember.new_chat_member.status)

    return oldStatusCheck && newStatusCheck
  }
}
