import { PERMISSION } from "@/access/catalog"
import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { Moderation, moderatorFor } from "@/modules/moderation"
import { ephemeral } from "@/utils/messages"

export const kick = new CommandsCollection<CommandAccess>("Kicking").createCommand({
  trigger: "kick",
  args: [{ key: "reason", optional: true, description: "Optional reason to kick the user" }],
  description: "Kick a user from a group",
  scope: "group",
  reply: "required",
  permissions: {
    requiredPermissions: [PERMISSION.moderate],
    allowTelegramChatAdmins: true,
  },
  handler: async ({ args, context, repliedTo, authorization }) => {
    if (!repliedTo.from) {
      logger.error("kick: no repliedTo.from field (the msg was sent in a channel)")
      return
    }

    const res = await Moderation.kick(
      repliedTo.from,
      context.chat,
      moderatorFor(context.from, authorization),
      [repliedTo],
      args.reason
    )
    if (res.isErr()) void ephemeral(context, res.error.fmtError)
  },
})
