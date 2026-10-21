import { PERMISSION } from "@/access/catalog"
import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { fmt } from "@/utils/format"
import { ephemeral, getText } from "@/utils/messages"

export const del = new CommandsCollection<string, CommandAccess>("Deletion").createCommand({
  trigger: "del",
  scope: "group",
  permissions: {
    requiredPermissions: [PERMISSION.messagesDelete],
    allowTelegramChatAdmins: true,
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
    if (res.isErr())
      void ephemeral(
        context,
        fmt(({ n }) => n`Cannot delete the message`)
      )
  },
})
