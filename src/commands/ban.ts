import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString, type Role } from "@/utils/types"
import { getUser } from "@/utils/users"
import { wait } from "@/utils/wait"

export const ban = new CommandsCollection<Role>("Banning")
  .createCommand({
    trigger: "ban",
    args: [{ key: "reason", optional: true, description: "Optional reason to ban the user" }],
    description: "Permanently ban a user from a group",
    scope: "group",
    reply: "required",
    permissions: {
      excludedRoles: ["creator"],
      allowedGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      if (!repliedTo.from) {
        logger.error("ban: no repliedTo.from field (the msg was sent in a channel)")
        return
      }

      const res = await Moderation.ban(repliedTo.from, context.chat, context.from, null, [repliedTo], args.reason)
      const msg = await context.reply(res.isErr() ? res.error.fmtError : "OK")
      void wait(5000).then(() => msg.delete())
    },
  })
  .createCommand({
    trigger: "tban",
    args: [
      {
        key: "duration",
        type: duration.zod,
        optional: false,
        description: `How long to ban the user. ${duration.formatDesc}`,
      },
      { key: "reason", optional: true, description: "Optional reason to ban the user" },
    ],
    description: "Temporary ban a user from a group",
    scope: "group",
    reply: "required",
    permissions: {
      excludedRoles: ["creator"],
      allowedGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      if (!repliedTo.from) {
        logger.error("ban: no repliedTo.from field (the msg was sent in a channel)")
        return
      }

      const res = await Moderation.ban(
        repliedTo.from,
        context.chat,
        context.from,
        args.duration,
        [repliedTo],
        args.reason
      )
      const msg = await context.reply(res.isErr() ? res.error.fmtError : "OK")
      void wait(5000).then(() => msg.delete())
    },
  })
  .createCommand({
    trigger: "unban",
    args: [{ key: "username", type: numberOrString, description: "Username (or user id) to unban" }],
    description: "Unban a user from a group",
    scope: "group",
    permissions: {
      excludedRoles: ["creator"],
      allowedGroupAdmins: true,
    },
    handler: async ({ args, context }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (!userId) {
        logger.debug(`unban: no userId for username ${args.username}`)
        const msg = await context.reply(fmt(({ b }) => b`@${context.from.username} user not found`))
        void wait(5000).then(() => msg.delete())
        return
      }

      const user = await getUser(userId, context)
      if (!user) {
        const msg = await context.reply("Error: cannot find this user")
        logger.error({ userId }, "UNBAN: cannot retrieve the user")
        void wait(5000).then(() => msg.delete())
        return
      }

      const res = await Moderation.unban(user, context.chat, context.from)
      const msg = await context.reply(res.isErr() ? res.error.fmtError : "OK")
      void wait(5000).then(() => msg.delete())
    },
  })
