import type { Filter } from "grammy"
import type { Chat } from "grammy/types"
import { GroupManagement } from "@/lib/group-management"
import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { type TelemetryContextFlavor, TrackedMiddleware } from "@/modules/telemetry"
import { redis } from "@/redis"
import { stripChatId } from "@/utils/chat"
import { fmtChat } from "@/utils/format"
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

function predicate<C extends Context>(ctx: C): ctx is C & { chat: Chat } {
  return ctx.chat !== undefined
}

type MemberContext<C extends Context> = Filter<C, "my_chat_member">
export class BotMembershipHandler<C extends TelemetryContextFlavor<Context>> extends TrackedMiddleware<C> {
  private TEMP_redis = new RedisFallbackAdapter<number>({
    redis,
    prefix: "TEMP_groups",
    logger,
  })

  constructor() {
    super("bot_membership_handler")

    // TEMP: this is for initial migration from previous bot
    this.composer.filter(predicate, async (ctx, next) => {
      if (ctx.chat.type === "private") return
      if (await this.TEMP_redis.has(ctx.chat.id.toString())) return next()

      const me = await ctx.getChatMember(ctx.me.id).catch(() => ({ status: "undefined" }))
      if (me.status !== "creator" && me.status !== "administrator") {
        modules
          .get("tgLogger")
          .exception({ type: "GENERIC", error: new Error(`Bot is NOT admin in group ${fmtChat(ctx.chat)}`) })
        logger.warn({ chat: ctx.chat }, "Cannot create group because bot is not admin")
        return next()
      }

      const res = await GroupManagement.create(ctx.chat.id, ctx.me)
      if (res.isOk()) await this.TEMP_redis.write(ctx.chat.id.toString(), ctx.chat.id)
      else logger.error({ chat: ctx.chat, error: res.error }, "Cannot create group")

      await next()
    })

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
