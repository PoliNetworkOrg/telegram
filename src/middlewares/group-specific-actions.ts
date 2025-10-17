import { Composer, type Filter, type MiddlewareObj } from "grammy"
import { err, ok, type Result } from "neverthrow"
import { api } from "@/backend"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { fmt, fmtUser } from "@/utils/format"
import type { Context } from "@/utils/types"
import { wait } from "@/utils/wait"

const TARGET_GROUPS: Record<string, number> = {
  alloggi: -1001175999519,
  ripetizioni: -1001495422899,
  books: -1001164044303,
} as const

const TARGET_GROUP_IDS_SET = new Set(Object.values(TARGET_GROUPS));

export class GroupSpecificActions<C extends Context> implements MiddlewareObj<C> {
  private composer = new Composer<C>()

  constructor() {
    this.composer
      .filter((ctx) => !!ctx.chatId && TARGET_GROUP_IDS_SET.has(ctx.chatId))
      .on("message", async (ctx, next) => {
        if (ctx.from.id === ctx.me.id) return next() // skip if bot
        const { roles } = await api.tg.permissions.getRoles.query({ userId: ctx.from.id })
        if (roles && roles.length > 0) return next() // skip if admin or other roles

        const chatMember = await ctx.getChatMember(ctx.from.id)
        if (chatMember.status === "administrator" || chatMember.status === "creator") return next() // skip if group-admin

        let check: Result<void, string>
        switch (ctx.chatId) {
          case TARGET_GROUPS.alloggi:
            check = this.checkAlloggi(ctx)
            break

          case TARGET_GROUPS.ripetizioni:
            check = this.checkRipetizioni(ctx)
            break

          case TARGET_GROUPS.books:
            check = this.checkBooks(ctx)
            break

          default:
            logger.error(
              { chatId: ctx.chatId, targetGroupsMap: TARGET_GROUPS },
              "GroupSpecificActions: target group matched, but no handler set. This is an unimplemented feature"
            )
            return next()
        }

        if (check.isOk()) return next()

        modules.get("tgLogger").delete([ctx.message], `User did not follow group rules:\n${check.error}`, ctx.me)
        const reply = await ctx.reply(
          fmt(({ b, n }) => [b`${fmtUser(ctx.from)} you sent an invalid message`, b`Reason:`, n`${check.error}`], {
            sep: "\n",
          }),
          { disable_notification: false, reply_markup: { force_reply: true } }
        )

        // delete error msg after 2 min without blocking the middleware stack
        void wait(120_000)
          .then(() => reply.delete())
          .catch(() => {})
      })
  }

  checkAlloggi(ctx: Filter<C, "message">): Result<void, string> {
    const hashtags = ctx.entities("hashtag").map((e) => e.text.toLowerCase())

    if (
      !hashtags.includes("#cerco") &&
      !hashtags.includes("#searching") &&
      !hashtags.includes("#search") &&
      !hashtags.includes("#offro") &&
      !hashtags.includes("#offering") &&
      !hashtags.includes("#offer")
    )
      return err(
        "You must include one of the following hashtags in your message:\n #cerco #searching #offro #offering \nCheck rules for more info."
      )

    return ok()
  }

  checkRipetizioni(ctx: Filter<C, "message">): Result<void, string> {
    const hashtags = ctx.entities("hashtag").map((e) => e.text.toLowerCase())

    if (
      !hashtags.includes("#richiesta") &&
      !hashtags.includes("#offerta") &&
      !hashtags.includes("#request") &&
      !hashtags.includes("#offer")
    )
      return err(
        "You must include one of the following hashtags in your message:\n #richiesta #request #offerta #offer \nCheck rules for more info."
      )

    return ok()
  }

  checkBooks(ctx: Filter<C, "message">): Result<void, string> {
    const hashtags = ctx.entities("hashtag").map((e) => e.text.toLowerCase())

    if (!hashtags.includes("#cerco") && !hashtags.includes("#vendo"))
      return err(
        "Devi includere uno di questi hashtags nel tuo messaggio:\n #cerco #vendo \nControlla le regole per maggiori indicazioni."
      )

    return ok()
  }

  middleware() {
    return this.composer.middleware()
  }
}
