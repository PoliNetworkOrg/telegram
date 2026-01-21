import { z } from "zod"
import { api } from "@/backend"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString, type Role } from "@/utils/types"
import { _commandsBase } from "./_base"

_commandsBase
  .createCommand({
    trigger: "getroles",
    scope: "private",
    description: "Get roles of an user",
    args: [
      {
        key: "username",
        type: numberOrString,
        description: "The username or the user id of the user you want to update the role",
      },
    ],
    handler: async ({ context, args }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (userId === null) {
        await context.reply("Not a valid userId or username not in our cache")
        return
      }

      try {
        const { roles } = await api.tg.permissions.getRoles.query({ userId })
        await context.reply(
          fmt(({ b }) => (roles?.length ? [`Roles:`, b`${roles.join(" ")}`] : "This user has no roles"))
        )
      } catch (err) {
        await context.reply(`There was an error: \n${String(err)}`)
      }
    },
  })
  .createCommand({
    trigger: "addrole",
    scope: "private",
    description: "Add role to user",
    args: [
      {
        key: "username",
        type: numberOrString,
        description: "The username or the user id of the user you want to update the role",
      },
      { key: "role", type: z.enum<Role[]>(["owner", "president", "direttivo", "hr", "admin"]) },
    ],
    permissions: {
      allowedRoles: ["owner", "direttivo"],
    },
    handler: async ({ context, args }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (userId === null) {
        await context.reply("Not a valid userId or username not in our cache")
        return
      }

      try {
        const { roles, error } = await api.tg.permissions.addRole.mutate({
          userId,
          adderId: context.from.id,
          role: args.role,
        })

        if (error) {
          await context.reply(fmt(({ n }) => n`There was an error: ${error}`))
          return
        }

        await context.reply(
          fmt(
            ({ b, n }) => [b`✅ Role added!`, n`${b`Username:`} ${args.username}`, n`${b`Updated roles:`} ${roles}`],
            {
              sep: "\n",
            }
          )
        )
        await context.deleteMessage()
      } catch (err) {
        await context.reply(`There was an error: \n${String(err)}`)
      }
    },
  })
  .createCommand({
    trigger: "delrole",
    scope: "private",
    description: "Remove role from an user",
    args: [
      {
        key: "username",
        type: numberOrString,
        description: "The username or the user id of the user you want to remove the role from",
      },
      { key: "role", type: z.enum<Role[]>(["owner", "president", "direttivo", "hr", "admin"]) },
    ],
    permissions: {
      allowedRoles: ["owner", "direttivo"],
    },
    handler: async ({ context, args }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (userId === null) {
        await context.reply("Not a valid userId or username not in our cache")
        return
      }

      try {
        const { roles, error } = await api.tg.permissions.removeRole.mutate({
          userId,
          removerId: context.from.id,
          role: args.role,
        })

        if (error) {
          await context.reply(fmt(({ n }) => n`There was an error: ${error}`))
          return
        }

        await context.reply(
          fmt(
            ({ b, n }) => [b`✅ Role removed!`, n`${b`Username:`} ${args.username}`, n`${b`Updated roles:`} ${roles}`],
            {
              sep: "\n",
            }
          )
        )
        await context.deleteMessage()
      } catch (err) {
        await context.reply(`There was an error: \n${String(err)}`)
      }
    },
  })
