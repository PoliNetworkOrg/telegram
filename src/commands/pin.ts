import { CommandsCollection } from "@/lib/managed-commands"
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
      const member = await context.getChatMember(context.me.id)
      if (member.status !== "administrator")
        return void ephemeral(context, fmt(({ n }) => n`❌ The bot is not an admin`))

      if (!member.can_pin_messages)
        return void ephemeral(
          context, fmt(({ n, code }) => n`❌ The bot is missing the ${code`Pin messages`} permission.`))

      const res = await context.pinChatMessage(repliedTo.message_id).catch(() => false)
      if (!res) return void ephemeral(context, fmt(({ n }) => n`❌ Cannot pin the message`))

      void ephemeral(context, fmt(({ n }) => n`✅ Message pinned`))
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
      const member = await context.getChatMember(context.me.id)
      if (member.status !== "administrator")
        return void ephemeral(context, fmt(({ n }) => n`❌ The bot is not an admin`))

      if (!member.can_pin_messages)
        return void ephemeral( 
          context,
          fmt(({ n, code }) => n`❌ The bot is missing the ${code`Pin messages`} permission.`)
        )

      const res = await context.unpinChatMessage(repliedTo.message_id).catch(() => false)
      if (!res) return void ephemeral(context, fmt(({ n }) => n`❌ Cannot unpin the message`))

      void ephemeral(context, fmt(({ n }) => n`✅ Message unpinned`))
    },
  })
