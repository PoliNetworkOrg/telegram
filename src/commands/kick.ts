import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { wait } from "@/utils/wait"

import { _commandsBase } from "./_base"

_commandsBase.createCommand({
  trigger: "kick",
  args: [{ key: "reason", optional: true, description: "Optional reason to kick the user" }],
  description: "Kick a user from a group",
  scope: "group",
  reply: "required",
  permissions: {
    excludedRoles: ["creator"],
    allowedGroupAdmins: true,
  },
  handler: async ({ args, context, repliedTo }) => {
    await context.deleteMessage()
    if (!repliedTo.from) {
      logger.error("kick: no repliedTo.from field (the msg was sent in a channel)")
      return
    }

    const res = await Moderation.kick({
      ctx: context,
      target: repliedTo.from,
      from: context.from,
      message: repliedTo,
      reason: args.reason,
    })
    if (res.isErr()) {
      const msg = await context.reply(res.error)
      await wait(5000)
      await msg.delete()
      return
    }

    await context.reply(res.value)
  },
})
