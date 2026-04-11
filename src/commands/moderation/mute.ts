import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString, type Role } from "@/utils/types"
import { getOverloadUser, getUser } from "@/utils/users"

export const mute = new CommandsCollection<Role>("Muting")
  .createCommand({
    trigger: "tmute",
    args: [
      {
        key: "duration",
        type: duration.zod,
        optional: false,
        description: `How long to mute the user. ${duration.formatDesc}`,
      },
      { key: "reason", optional: true, description: "Optional reason to mute the user" },
    ],
    description: "Temporary mute a user from a group",
    scope: "group",
    reply: "required",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      if (!repliedTo.from) {
        logger.error("tmute: no repliedTo.from field (the msg was sent in a channel)")
        return
      }

      const res = await Moderation.mute(
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
    trigger: "mute",
    args: [
      {
        key: "reasonOrUser",
        optional: true,
        description:
          "If the message is a reply, this argument is the reason. Otherwise, it's the username or user id of the user to mute",
        type: numberOrString,
      },
      { key: "reason", optional: true, description: "Optional reason to mute the user" },
    ],
    description: "Permanently mute a user from a group",
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
              : fmt(({ n }) => n`Target user not found, please try replying to their message`)
          )
        )
        logger.error({ args, repliedTo }, `MUTE: ${userOverload.error}`)
        return
      }

      const { user, reason } = userOverload.value

      const res = await Moderation.mute(
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
    trigger: "unmute",
    args: [{ key: "username", type: numberOrString, description: "Username (or user id) to unmute" }],
    description: "Unmute a user from a group",
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
        logger.debug(`unmute: no userId for username ${args.username}`)
        const msg = await context.reply(fmt(({ b }) => b`@${context.from.username} user not found`))
        await ephemeral(msg)
        return
      }

      const user = await getUser(userId, context)
      if (!user) {
        const msg = await context.reply(fmt(({ n }) => n`Error: cannot find this user`))
        logger.error({ userId }, "UNMUTE: cannot retrieve the user")
        await ephemeral(msg)
        return
      }

      const res = await Moderation.unmute(user, context.chat, context.from)
      if (res.isErr()) await ephemeral(context.reply(res.error.fmtError))
    },
  })
