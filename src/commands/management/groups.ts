import z from "zod"
import { GroupManagement } from "@/lib/group-management"
import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { fmt } from "@/utils/format"
import type { Role } from "@/utils/types"
import { printUsername } from "@/utils/users"

export const groups = new CommandsCollection<Role>("Groups").createCommand({
  trigger: "updategroup",
  scope: "private",
  description: "Get the audit log of a user",
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
    if (!group)
      return void context.reply(
        fmt(
          ({ code, n }) =>
            n`Group with chatId ${code`${args.chatId}`} does not exists or the bot is not an administrator.`
        )
      )

    if (group.type === "private")
      return void context.reply(
        fmt(({ code, n }) => n`Chat with chatId ${code`${args.chatId}`} is a private chat, not a group.`)
      )

    const res = await GroupManagement.update(group.id, context.from)
    if (res.isErr()) {
      logger.error(
        { error: res.error, chatId: args.chatId, requestedBy: printUsername(context.from) },
        "[command:updategroup] could not update or create group"
      )
      return void context.reply(
        fmt(({ code, n, b, i }) => [b`There was an ERROR`, n`chatId: ${code`${args.chatId}`}`, i`\n${res.error}`], {
          sep: "\n",
        })
      )
    }

    logger.info(
      { chatId: args.chatId, requestedBy: printUsername(context.from) },
      "[command:updategroup] group updated"
    )
    await context.reply(
      fmt(({ code, n, b }) => [b`✅ Group Updated`, n`chatId: ${code`${args.chatId}`}`], {
        sep: "\n",
      })
    )
  },
})
