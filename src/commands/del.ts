import { logger } from "@/logger"
import { modules } from "@/modules"
import { getText } from "@/utils/messages"
import { _commandsBase } from "./_base"

_commandsBase.createCommand({
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

    await modules.get("tgLogger").preDelete([repliedTo], "Command /del", context.from) // actual message to delete
    await Promise.all([
      context.deleteMessages([repliedTo.message_id]),
      context.deleteMessage(), // /del message
    ])
  },
})
