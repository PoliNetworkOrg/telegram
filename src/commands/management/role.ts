import { z } from "zod"
import { decisionMode, resolveOne } from "@/access"
import { PERMISSION } from "@/access/catalog"
import { legacyBackend, serviceBackend } from "@/backend"
import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString, type Role } from "@/utils/types"

export const role = new CommandsCollection<Role, CommandAccess>("Roles")
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
    // Open to everyone before the IdP migration; RFC v3 §10.2 restricts it.
    permissions: { requiredPermissions: [PERMISSION.usersRead] },
    handler: async ({ context, args }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (userId === null) {
        await context.reply(fmt(({ n }) => n`Not a valid userId or username not in our cache`))
        return
      }

      // The source the bot decides with: the IdP once its decisions apply, the legacy roles before that.
      const permissions =
        decisionMode === "enforce"
          ? [...(await resolveOne(serviceBackend, userId)).permissions].sort()
          : ((await legacyBackend.tg.permissions.getRoles.query({ userId })).roles ?? [])
      await context.reply(
        fmt(({ b, n }) =>
          permissions.length ? n`Permissions: ${b`${permissions.join(" ")}`}` : "This user has no permissions"
        )
      )
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
        await context.reply(fmt(({ n }) => n`Not a valid userId or username not in our cache`))
        return
      }

      const { roles, error } = await legacyBackend.tg.permissions.addRole.mutate({
        userId,
        adderId: context.from.id,
        role: args.role,
      })

      if (error) {
        await context.reply(fmt(({ n }) => n`There was an error: ${error}`))
        return
      }

      await context.reply(
        fmt(({ b, n }) => [b`✅ Role added!`, n`${b`Username:`} ${args.username}`, n`${b`Updated roles:`} ${roles}`], {
          sep: "\n",
        })
      )
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
        await context.reply(fmt(({ n }) => n`Not a valid userId or username not in our cache`))
        return
      }

      const { roles, error } = await legacyBackend.tg.permissions.removeRole.mutate({
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
          { sep: "\n" }
        )
      )
    },
  })
