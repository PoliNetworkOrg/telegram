import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { getText } from "@/utils/messages"
import { wait } from "@/utils/wait"
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
    await context.deleteMessage()
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
    await wait(5000)
    await msg.delete()
  },
})
