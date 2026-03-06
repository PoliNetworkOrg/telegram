import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { getText } from "@/utils/messages"
import type { Role } from "@/utils/types"
import { wait } from "@/utils/wait"

export const del = new CommandsCollection<Role>("Deletion").createCommand({
  trigger: "del",
  scope: "group",
  permissions: {
    allowedRoles: ["admin", "owner", "direttivo"],
    allowedGroupAdmins: true,
  },
  description: "Deletes the replied to message",
  reply: "required",
  handler: async ({ repliedTo, context }) => {
    const { text, type } = getText(repliedTo)
    logger.info({
      action: "delete_message",
      messageText: text ?? "[non-textual]",
      messageType: type,
      sender: repliedTo.from?.username,
    })

    const res = await Moderation.deleteMessages([repliedTo], context.from, "Command /del")
    // TODO: better error and ok response
    const msg = await context.reply(res.isErr() ? "Cannot delete the message" : "OK")
    void wait(5000).then(() => msg.delete())
  },
})
