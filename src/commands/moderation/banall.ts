import type { User } from "grammy/types"
import z from "zod"
import { api } from "@/backend"
import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString, type Role } from "@/utils/types"

const BYPASS_ROLES: Role[] = ["president", "owner", "direttivo"]

export const banAll = new CommandsCollection<Role>("Ban All")
  .createCommand({
    trigger: "ban_all",
    description: "PERMA BAN a user from all the Network's groups",
    scope: "private",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
    },
    args: [
      {
        key: "username",
        type: numberOrString,
        description: "The username or the user id of the user you want to ban from all groups",
      },
      {
        key: "reason",
        type: z.string(),
        description: "The reason why you ban the user",
      },
    ],
    handler: async ({ args, context }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username
      logger.debug(
        { userId, arg: args.username, isString: typeof args.username === "string" },
        "debug ban all username"
      )

      if (userId === null) {
        await context.reply(fmt(({ n }) => n`Not a valid userId or username not in our cache`))
        return
      }

      const dbUser = await api.tg.users.get.query({ userId })
      const { roles } = await api.tg.permissions.getRoles.query({ userId })
      if (roles?.some((r) => BYPASS_ROLES.includes(r))) {
        await context.reply(fmt(({ n }) => n`This user has special roles so cannot be banned.`))
        return
      }

      const target: User | number = dbUser.user
        ? {
            id: userId,
            first_name: dbUser.user.firstName,
            last_name: dbUser.user.lastName,
            username: dbUser.user.username,
            is_bot: dbUser.user.isBot,
            language_code: dbUser.user.langCode,
          }
        : userId

      await modules.get("tgLogger").banAll(target, context.from, "BAN", args.reason)
      await context.reply(
        fmt(({ n, link }) => n`Ban All started for userId ${link(userId.toString(), `tg://user?id=${userId}`)}`)
      )
    },
  })
  .createCommand({
    trigger: "unban_all",
    description: "UNBAN a user from all the Network's groups",
    scope: "private",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
    },
    args: [
      {
        key: "username",
        type: numberOrString,
        description: "The username or the user id of the user you want to unban from all groups",
      },
    ],
    handler: async ({ args, context }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (userId === null) {
        await context.reply(fmt(({ n }) => n`Not a valid userId or username not in our cache`))
        return
      }

      const dbUser = await api.tg.users.get.query({ userId })

      const target: User | number = dbUser.user
        ? {
            id: userId,
            first_name: dbUser.user.firstName,
            last_name: dbUser.user.lastName,
            username: dbUser.user.username,
            is_bot: dbUser.user.isBot,
            language_code: dbUser.user.langCode,
          }
        : userId

      await modules.get("tgLogger").banAll(target, context.from, "UNBAN")
      await context.reply(
        fmt(({ n, link }) => n`UN-Ban All started for userId ${link(userId.toString(), `tg://user?id=${userId}`)}`)
      )
    },
  })
