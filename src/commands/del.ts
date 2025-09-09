import { tgLogger } from "@/bot"
import { logger } from "@/logger"
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

    await tgLogger.delete([repliedTo], "Command /del", context.from) // actual message to delete
    await context.deleteMessage() // /del message 
  },
})
