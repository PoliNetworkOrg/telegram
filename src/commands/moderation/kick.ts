import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { ephemeral } from "@/utils/messages"
import type { Role } from "@/utils/types"

export const kick = new CommandsCollection<Role>("Kicking").createCommand({
  trigger: "kick",
  args: [{ key: "reason", optional: true, description: "Optional reason to kick the user" }],
  description: "Kick a user from a group",
  scope: "group",
  reply: "required",
  permissions: {
    allowedRoles: ["owner", "direttivo"],
    excludedRoles: ["creator"],
    allowGroupAdmins: true,
  },
  handler: async ({ args, context, repliedTo }) => {
    if (!repliedTo.from) {
      logger.error("kick: no repliedTo.from field (the msg was sent in a channel)")
      return
    }

    const res = await Moderation.kick(repliedTo.from, context.chat, context.from, [repliedTo], args.reason)
    if (res.isErr()) await ephemeral(context.reply(res.error.fmtError))
  },
})
