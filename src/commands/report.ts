import type { Context, Filter } from "grammy"
import type { Message } from "grammy/types"
import type { CommandScopedContext } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { fmt } from "@/utils/format"
import { _commandsBase } from "./_base"

export const report = async (context: Filter<Context, "message"> | CommandScopedContext, repliedTo: Message) => {
  const reportSent = await modules.get("tgLogger").report(repliedTo, context.from)
  await context.reply(
    reportSent
      ? fmt(({ b, n }) => [b`✅ Message reported!`, n`Moderators have been notified.`], { sep: "\n" })
      : fmt(({ b, n }) => [b`⚠️ Report not sent`, n`Please try again in a moment.`], { sep: "\n" }),
    {
      disable_notification: false,
      reply_parameters: { message_id: repliedTo.message_id },
    }
  )
}

_commandsBase.createCommand({
  trigger: "report",
  description: "Report a message to admins",
  scope: "group",
  reply: "required",
  handler: async ({ context, repliedTo }) => {
    await context.deleteMessage()
    if (!repliedTo.from) {
      logger.error("report: no repliedTo.from field (the msg was sent in a channel)")
      return
    }

    await report(context, repliedTo)
  },
})
