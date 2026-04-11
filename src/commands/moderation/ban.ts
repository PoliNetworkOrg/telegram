import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString, type Role } from "@/utils/types"
import { getOverloadUser, getUser } from "@/utils/users"

export const ban = new CommandsCollection<Role>("Banning")
  .createCommand({
    trigger: "ban",
    args: [
      {
        key: "reasonOrUser",
        optional: true,
        description:
          "If the message is a reply, this argument is the reason. Otherwise, it's the username or user id of the user to ban",
        type: numberOrString,
      },
      { key: "reason", optional: true, description: "Optional reason to ban the user" },
    ],
    description: "Permanently ban a user from a group",
    scope: "group",
    reply: "optional",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      const userOverload = await getOverloadUser(context, repliedTo, args.reasonOrUser, args.reason)
      if (userOverload.isErr()) {
        await ephemeral(
          context.reply(
            repliedTo
              ? fmt(({ n }) => n`There was an error`)
              : fmt(({ n }) => n`Target user not found, please try replying to a their message`)
          )
        )
        logger.error({ args, repliedTo }, `BAN: ${userOverload.error}`)
        return
      }

      const { user, reason } = userOverload.value

      const res = await Moderation.ban(
        user,
        context.chat,
        context.from,
        null,
        repliedTo ? [repliedTo] : undefined,
        reason
      )
      if (res.isErr()) await ephemeral(context.reply(res.error.fmtError))
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
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
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
      if (res.isErr()) await ephemeral(context.reply(res.error.fmtError))
    },
  })
  .createCommand({
    trigger: "unban",
    args: [{ key: "username", type: numberOrString, description: "Username (or user id) to unban" }],
    description: "Unban a user from a group",
    scope: "group",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

      if (!userId) {
        logger.debug(`unban: no userId for username ${args.username}`)
        await ephemeral(context.reply(fmt(({ b }) => b`@${context.from.username} user not found`)))
        return
      }

      const user = await getUser(userId, context)
      if (!user) {
        logger.error({ userId }, "UNBAN: cannot retrieve the user")
        await ephemeral(context.reply(fmt(({ n }) => [n`Error: cannot find this user`])))
        return
      }

      const res = await Moderation.unban(user, context.chat, context.from)
      if (res.isErr()) await ephemeral(context.reply(res.error.fmtError))
    },
  })
