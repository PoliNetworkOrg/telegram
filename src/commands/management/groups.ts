import z from "zod"
import { GroupManagement } from "@/lib/group-management"
import { CommandsCollection } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"
import type { Role } from "@/utils/types"

export const groups = new CommandsCollection<Role>("Groups").createCommand({
  trigger: "updategroup",
  scope: "private",
  description: "Trigger group info update to the database (eg. title or tag change)",
  args: [
    {
      key: "chatId",
      optional: false,
      type: z.coerce.number(),
      description: "Chat ID (number, obtained from alternative clients) of the group you want to force update",
    },
  ],
  permissions: {
    allowedRoles: ["owner", "direttivo"],
  },
  handler: async ({ context, args }) => {
    const group = await context.api.getChat(args.chatId).catch(() => null)
    if (!group) {
      await context.reply(
        fmt(
          ({ code, n }) =>
            n`Group with chatId ${code`${args.chatId}`} does not exists or the bot is not an administrator.`
        )
      )
      return
    }

    if (group.type === "private") {
      await context.reply(
        fmt(({ code, n }) => n`Chat with chatId ${code`${args.chatId}`} is a private chat, not a group.`)
      )
      return
    }

    const res = await GroupManagement.update(group.id, context.from)
    if (res.isErr()) {
      await context.reply(
        fmt(({ code, n, b, i }) => [b`There was an ERROR`, n`chatId: ${code`${args.chatId}`}`, i`\n${res.error}`], {
          sep: "\n",
        })
      )
      return
    }

    await context.reply(
      fmt(({ code, n, b }) => [b`✅ Group Updated`, n`chatId: ${code`${args.chatId}`}`], {
        sep: "\n",
      })
    )
  },
})
