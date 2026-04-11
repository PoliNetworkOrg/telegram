import type { Filter, MiddlewareFn } from "grammy"
import { logger } from "@/logger"
import { RestrictPermissions } from "@/utils/chat"
import { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import type { Context } from "@/utils/types"

export const checkUsername: MiddlewareFn<Filter<Context, "message">> = async (ctx, next) => {
  if (ctx.from.username === undefined) {
    const res = await ctx
      .restrictAuthor(RestrictPermissions.mute, { until_date: duration.fromSeconds(60).timestamp_s })
      .catch(() => false)

    if (!res) logger.warn(`checkUsername: cannot restrict user ${ctx.from.id}`)

    const msg = fmt(({ i, link }) => [
      i`[Message for ${link(ctx.from.first_name, `tg://user?id=${ctx.from.id}`)}]`,
      `\n\nYou must set an username in Telegram settings to write in PoliNetwork's groups`,
      `Please set an username and try again in 60 seconds!`,
    ])

    await ctx.deleteMessage()
    void ephemeral(ctx.reply(msg), 30_000)
  }
  await next()
}
