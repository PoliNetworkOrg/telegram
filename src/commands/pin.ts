import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import type { Role } from "@/utils/types"

export const pin = new CommandsCollection<Role>()
  .createCommand({
    trigger: "pin",
    description: "Pin a message in a group",
    scope: "group",
    reply: "required",
    permissions: {
      allowGroupAdmins: true,
      allowedRoles: ["direttivo", "owner"],
    },
    handler: async ({ context, repliedTo }) => {
      if (!repliedTo.from) {
        logger.error("report: no repliedTo.from field (the msg was sent in a channel)")
        return
      }

      const member = await context.getChatMember(context.me.id)
      if (member.status !== "administrator")
        return await ephemeral(context.reply(fmt(({ n }) => n`❌ The bot is not an admin`)), 10_000)

      if (!member.can_pin_messages)
        return await ephemeral(
          context.reply(fmt(({ n, code }) => n`❌ The bot is missing the ${code`Pin messages`} permission.`)),
          10_000
        )

      const res = await context.pinChatMessage(repliedTo.message_id).catch(() => false)
      if (!res) return await ephemeral(context.reply(fmt(({ n }) => n`❌ Cannot pin the message`)), 10_000)

      await ephemeral(context.reply(fmt(({ n }) => n`✅ Message pinned`)), 10_000)
    },
  })
  .createCommand({
    trigger: "unpin",
    description: "Unpin a message in a group",
    scope: "group",
    reply: "required",
    permissions: {
      allowGroupAdmins: true,
      allowedRoles: ["direttivo", "owner"],
    },
    handler: async ({ context, repliedTo }) => {
      if (!repliedTo.from) {
        logger.error("report: no repliedTo.from field (the msg was sent in a channel)")
        return
      }

      const member = await context.getChatMember(context.me.id)
      if (member.status !== "administrator")
        return await ephemeral(context.reply(fmt(({ n }) => n`❌ The bot is not an admin`)), 10_000)

      if (!member.can_pin_messages)
        return await ephemeral(
          context.reply(fmt(({ n, code }) => n`❌ The bot is missing the ${code`Pin messages`} permission.`)),
          10_000
        )

      const res = await context.unpinChatMessage(repliedTo.message_id).catch(() => false)
      if (!res) return await ephemeral(context.reply(fmt(({ n }) => n`❌ Cannot unpin the message`)), 10_000)

      await ephemeral(context.reply(fmt(({ n }) => n`✅ Message pinned`)), 10_000)
    },
  })
