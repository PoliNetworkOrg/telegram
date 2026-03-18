import { Composer, type Filter, type MiddlewareObj } from "grammy"
import { logReport } from "@/commands/report"
import { logger } from "@/logger"
import type { Context } from "@/utils/types"

type MentionContext<C extends Context> = Filter<C, "message:entities:mention">
export class MentionListener<C extends Context> implements MiddlewareObj<C> {
  private composer = new Composer<C>()

  constructor() {
    this.composer
      .on("message:entities:mention")
      .fork()
      .filter(
        (ctx) => ctx.entities("mention").some((m) => m.text === "@admin"),
        (ctx) => this.handleReport(ctx)
      )
  }

  middleware() {
    return this.composer.middleware()
  }

  private async handleReport(ctx: MentionContext<C>) {
    await ctx.deleteMessage()
    const repliedTo = ctx.message.reply_to_message
    if (!repliedTo?.from) {
      logger.error("report: no repliedTo or repliedTo.from field (the msg was sent in a channel)")
      return
    }

    await logReport(ctx, repliedTo)
  }
}
