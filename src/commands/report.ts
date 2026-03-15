import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { fmt } from "@/utils/format"
import type { Role } from "@/utils/types"

export const report = new CommandsCollection<Role>("Reporting").createCommand({
  trigger: ["report", "admin"],
  description: "Report a message to admins",
  scope: "group",
  reply: "required",
  handler: async ({ context, repliedTo }) => {
    if (!repliedTo.from) {
      logger.error("report: no repliedTo.from field (the msg was sent in a channel)")
      return
    }

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
  },
})
