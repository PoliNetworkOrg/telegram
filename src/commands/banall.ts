import type { User } from "grammy/types"
import z from "zod"
import { api } from "@/backend"
import { modules } from "@/modules"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString, type Role } from "@/utils/types"
import { _commandsBase } from "./_base"

const BYPASS_ROLES: Role[] = ["president", "owner", "direttivo"]

_commandsBase
  .createCommand({
    trigger: "ban_all",
    description: "PREMA BAN a user from all the Network's groups",
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
      await context.deleteMessage()

      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (userId === null) {
        await context.reply("Not a valid userId or username not in our cache")
        return
      }

      const dbUser = await api.tg.users.get.query({ userId })
      const { roles } = await api.tg.permissions.getRoles.query({ userId })
      if (roles?.some((r) => BYPASS_ROLES.includes(r))) {
        await context.reply("This user has special roles so cannot be banned.")
        return
      }

      if (!dbUser || dbUser.error) {
        await context.reply("This user is not in our cache, we cannot proceed.")
        return
      }

      const target: User = {
        id: userId,
        first_name: dbUser.user.firstName,
        last_name: dbUser.user.lastName,
        username: dbUser.user.username,
        is_bot: dbUser.user.isBot,
        language_code: dbUser.user.langCode,
      }

      await modules.get("tgLogger").banAll(target, context.from, "BAN", args.reason)
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
        description: "The username or the user id of the user you want to update the role",
      },
    ],
    handler: async ({ args, context }) => {
      await context.deleteMessage()

      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (userId === null) {
        await context.reply("Not a valid userId or username not in our cache")
        return
      }

      const dbUser = await api.tg.users.get.query({ userId })
      if (!dbUser || dbUser.error) {
        await context.reply("This user is not in our cache, we cannot proceed.")
        return
      }

      const target: User = {
        id: userId,
        first_name: dbUser.user.firstName,
        last_name: dbUser.user.lastName,
        username: dbUser.user.username,
        is_bot: dbUser.user.isBot,
        language_code: dbUser.user.langCode,
      }

      await modules.get("tgLogger").banAll(target, context.from, "UNBAN")
    },
  })
