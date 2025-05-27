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
    if (repliedTo.from && context.from)
      await tgLogger.adminAction({
        type: "DELETE",
        target: repliedTo.from,
        from: context.from,
        message: repliedTo,
        chat: repliedTo.chat,
      })
    await context.deleteMessages([repliedTo.message_id])
    await context.deleteMessage()
  },
})
