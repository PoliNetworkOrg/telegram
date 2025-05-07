import { Filter, MiddlewareFn } from "grammy"
import { Context } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"
import { logger } from "@/logger"
import { RestrictPermissions } from "@/utils/chat"

export const checkUsername: MiddlewareFn<Filter<Context, "message">> = async (ctx, next) => {
  if (ctx.from.username === undefined) {
    const res = await ctx
      .restrictAuthor(RestrictPermissions.mute, { until_date: Date.now() + 300_000 })
      .catch(() => false)

    if (!res) logger.warn(`checkUsername: cannot restrict user ${ctx.from.id}`)

    const msg = fmt(({ i, link }) => [
      i`[Message for ${link(ctx.from.first_name, `tg://user?id=${ctx.from.id}`)}]`,
      `\n\nYou must set an username in Telegram settings to write in PoliNetwork's groups`,
    ])

    const reply = await ctx.reply(msg)
    await ctx.deleteMessage()
    setTimeout(() => void reply.delete(), 10_000)
  }
  await next()
}
