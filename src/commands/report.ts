import { logger } from "@/logger"
import { modules } from "@/modules"
import { _commandsBase } from "./_base"

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

    await modules.get("tgLogger").report(repliedTo, context.from)
  },
})
