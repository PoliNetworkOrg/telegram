import { api } from "@/backend"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import type { Role } from "@/utils/types"
import { z } from "zod"

import { _commandsBase } from "./_base"

_commandsBase
  .createCommand({
    trigger: "getrole",
    scope: "private",
    description: "Get role of userid",
    args: [{ key: "userId" }],
    handler: async ({ context, args }) => {
      let userId: number | null = parseInt(args.userId, 10)
      if (Number.isNaN(userId)) {
        userId = await getTelegramId(args.userId.replaceAll("@", ""))
      }
      if (userId === null) {
        await context.reply("Not a valid userId or username not in our cache")
        return
      }

      try {
        const { role } = await api.tg.permissions.getRole.query({ userId })
        await context.reply(fmt(({ b }) => [`Role:`, b`${role}`]))
      } catch (err) {
        await context.reply(`There was an error: \n${String(err)}`)
      }
    },
  })
  .createCommand({
    trigger: "setrole",
    scope: "private",
    description: "Set role of username",
    args: [
      { key: "username", description: "The username or the user id of the user you want to update the role" },
      { key: "role", type: z.enum<Role[]>(["direttivo", "hr", "admin"]) },
    ],
    permissions: {
      allowedRoles: ["owner", "direttivo"],
    },
    handler: async ({ context, args }) => {
      let userId: number | null = null
      if (!Number.isNaN(args.username)) {
        userId = await getTelegramId(args.username.replaceAll("@", ""))
      } else {
        userId = parseInt(args.username, 10)
      }

      if (userId === null) {
        await context.reply("Not a valid userId or username not in our cache")
        return
      }

      try {
        const { role: prev } = await api.tg.permissions.getRole.query({ userId })
        await api.tg.permissions.setRole.query({ userId, adderId: context.from.id, role: args.role })
        await context.reply(
          fmt(
            ({ b, n }) => [
              b`✅ Role set!`,
              n`${b`Username:`} ${args.username}`,
              n`${b`Role`}: ${prev} -> ${args.role}`,
            ],
            { sep: "\n" }
          )
        )
        await context.deleteMessage()
      } catch (err) {
        await context.reply(`There was an error: \n${String(err)}`)
      }
    },
  })
