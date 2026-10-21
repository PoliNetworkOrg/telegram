import type { User } from "grammy/types"
import z from "zod"
import { PERMISSION } from "@/access/catalog"
import { serviceBackend } from "@/backend"
import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { moderatorFor } from "@/modules/moderation"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString } from "@/utils/types"

export const banAll = new CommandsCollection<string, CommandAccess>("Ban All")
  .createCommand({
    trigger: "ban_all",
    description: "PERMA BAN a user from all the Network's groups",
    scope: "private",
    permissions: {
      requiredPermissions: [PERMISSION.moderateGlobal],
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
    handler: async ({ args, context, authorization }) => {
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

      const dbUser = await serviceBackend.tg.users.get.query({ userId })

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

      // The target's immunity is checked by banAll.
      const result = await modules
        .get("tgLogger")
        .banAll(target, moderatorFor(context.from, authorization), "BAN", "command", args.reason)
      await context.reply(result.message)
    },
  })
  .createCommand({
    trigger: "unban_all",
    description: "UNBAN a user from all the Network's groups",
    scope: "private",
    permissions: {
      requiredPermissions: [PERMISSION.moderateGlobal],
    },
    args: [
      {
        key: "username",
        type: numberOrString,
        description: "The username or the user id of the user you want to unban from all groups",
      },
    ],
    handler: async ({ args, context, authorization }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (userId === null) {
        await context.reply(fmt(({ n }) => n`Not a valid userId or username not in our cache`))
        return
      }

      const dbUser = await serviceBackend.tg.users.get.query({ userId })

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

      const result = await modules
        .get("tgLogger")
        .banAll(target, moderatorFor(context.from, authorization), "UNBAN", "command")
      await context.reply(result.message)
    },
  })
