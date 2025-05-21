import type { Context } from "@/lib/managed-commands"
import type { Filter, MiddlewareFn } from "grammy"

import { api } from "@/backend"
import { fmt } from "@/utils/format"

type Config = {
  logChatId: number
}
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

export function botJoin({ logChatId }: Config): MiddlewareFn<Filter<Context, "my_chat_member">> {
  return async (ctx, next) => {
    const chat = ctx.myChatMember.chat.type
    const status = ctx.myChatMember.new_chat_member.status

    // execute only if it's a join event
    if (joinEvent[chat].includes(status)) {
      const { allowed } = await api.tg.permissions.canAddBot.query({ userId: ctx.myChatMember.from.id })
      if (!allowed) {
        const left = await ctx.leaveChat().catch(() => false)
        await ctx.api.sendMessage(
          logChatId,
          fmt(
            ({ b, code, n, i, u }) => [
              b`Invalid Bot Join`,
              n`${b`From:`} ${ctx.myChatMember.from.username ?? ""} [${code`${ctx.myChatMember.from.id}`}]`,
              n`${b`Chat:`} ${ctx.myChatMember.chat.title ?? ""} [${code`${ctx.myChatMember.chat.id}`}] (${ctx.myChatMember.chat.type})`,
              left ? i`\nBot has left the chat` : u`WARN: Bot could not leave the chat`,
            ],
            { sep: "\n" }
          )
        )
      }
    }

    await next()
  }
}
