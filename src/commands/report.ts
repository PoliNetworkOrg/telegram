import type { Context, Filter } from "grammy"
import type { Message } from "grammy/types"
import type { CommandScopedContext } from "@/lib/managed-commands"
import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import type { Role } from "@/utils/types"

export const logReport = async (context: Filter<Context, "message"> | CommandScopedContext, repliedTo: Message) => {
  const reportSent = await modules.get("tgLogger").report(repliedTo, context.from)

  let msg: string = ""
  if (reportSent === "SENT")
    msg = fmt(({ b, n }) => [b`✅ Message reported!`, n`Moderators have been notified.`], { sep: "\n" })
  else if (reportSent === "ALREADY_SENT")
    msg = fmt(({ b, n }) => [b`☑️ Message already reported!`, n`Moderators have been notified.`], { sep: "\n" })
  else if (reportSent === "ERROR")
    msg = fmt(({ b, n }) => [b`⚠️ Report not sent`, n`Please try again in a moment.`], { sep: "\n" })

  const feedback = await context.reply(msg, {
    disable_notification: false,
    reply_parameters: { message_id: repliedTo.message_id },
  })

  if (reportSent !== "SENT") void ephemeral(feedback)
}

export const report = new CommandsCollection<Role>().createCommand({
  trigger: ["report", "admin"],
  description: "Report a message to admins",
  scope: "group",
  reply: "required",
  handler: async ({ context, repliedTo }) => {
    if (!repliedTo.from) {
      logger.error("report: no repliedTo.from field (the msg was sent in a channel)")
      return
    }

    await logReport(context, repliedTo)
  },
})
