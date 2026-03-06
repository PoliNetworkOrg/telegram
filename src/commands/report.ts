import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { modules } from "@/modules"
import type { Role } from "@/utils/types"

export const report = new CommandsCollection<Role>("Reporting").createCommand({
  trigger: "report",
  description: "Report a message to admins",
  scope: "group",
  reply: "required",
  handler: async ({ context, repliedTo }) => {
    if (!repliedTo.from) {
      logger.error("report: no repliedTo.from field (the msg was sent in a channel)")
      return
    }

    await modules.get("tgLogger").report(repliedTo, context.from)
  },
})
