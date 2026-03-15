import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString, type Role } from "@/utils/types"
import { getUser } from "@/utils/users"
import { wait } from "@/utils/wait"

export const mute = new CommandsCollection<Role>("Muting")
  .createCommand({
    trigger: "tmute",
    args: [
      {
        key: "duration",
        type: duration.zod,
        optional: false,
        description: `How long to mutate the user. ${duration.formatDesc}`,
      },
      { key: "reason", optional: true, description: "Optional reason to mutate the user" },
    ],
    description: "Temporary mute a user from a group",
    scope: "group",
    reply: "required",
    permissions: {
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
      if (res.isErr()) void ephemeral(context.reply(res.error.fmtError))
    },
  })
  .createCommand({
    trigger: "mute",
    args: [{ key: "reason", optional: true, description: "Optional reason to mutate the user" }],
    description: "Permanently mute a user from a group",
    scope: "group",
    reply: "required",
    permissions: {
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      if (!repliedTo.from) {
        logger.error("mute: no repliedTo.from field (the msg was sent in a channel)")
        return
      }

      const res = await Moderation.mute(repliedTo.from, context.chat, context.from, null, [repliedTo], args.reason)
      if (res.isErr()) void ephemeral(context.reply(res.error.fmtError))
    },
  })
  .createCommand({
    trigger: "unmute",
    args: [{ key: "username", type: numberOrString, description: "Username (or user id) to unmute" }],
    description: "Unmute a user from a group",
    scope: "group",
    permissions: {
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context }) => {
      const userId: number | null =
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username
      if (!userId) {
        logger.debug(`unmute: no userId for username ${args.username}`)
        const msg = await context.reply(fmt(({ b }) => b`@${context.from.username} user not found`))
        void wait(5000).then(async () => msg.delete())
        return
      }

      const user = await getUser(userId, context)
      if (!user) {
        const msg = await context.reply("Error: cannot find this user")
        logger.error({ userId }, "UNMUTE: cannot retrieve the user")
        void wait(5000).then(async () => msg.delete())
        return
      }

      const res = await Moderation.unmute(user, context.chat, context.from)
      if (res.isErr()) void ephemeral(context.reply(res.error.fmtError))
    },
  })
