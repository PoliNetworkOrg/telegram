import { Filter, MiddlewareFn } from "grammy"
import { Context } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"
import { logger } from "@/logger"

export const checkUsername: MiddlewareFn<Filter<Context, "message">> = async (ctx, next) => {
  if (ctx.from.username !== undefined) {
    const res = await ctx
      .restrictAuthor(
        {
          can_send_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
        },
        { until_date: Date.now() + 300_000 }
      )
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
