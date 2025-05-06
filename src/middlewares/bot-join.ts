import { api } from "@/backend"
import { Context } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"
import { Filter, MiddlewareFn } from "grammy"

type Config = {
  logChatId: number
}

export function botJoin({ logChatId }: Config): MiddlewareFn<Filter<Context, "my_chat_member">> {
  return async (ctx, next) => {
    const groupJoin =
      ["group", "supergroup"].includes(ctx.myChatMember.chat.type) &&
      ctx.myChatMember.new_chat_member.status === "member"
    const channelJoin =
      ctx.myChatMember.chat.type === "channel" && ctx.myChatMember.new_chat_member.status === "administrator"
    if (groupJoin || channelJoin) {
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
