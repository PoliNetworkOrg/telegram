import type { User } from "grammy/types"
import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { Moderation } from "@/modules/moderation"
import { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import { numberOrString, type Role } from "@/utils/types"
import { getUserFromIdOrUsername } from "@/utils/users"

export const ban = new CommandsCollection<Role>("Banning")
  .createCommand({
    trigger: "ban",
    args: [
      {
        key: "reasonOrUser",
        optional: true,
        type: numberOrString,
        description:
          "If the message is a reply, this argument is the reason. Otherwise, it's the username or user id of the user to mute",
      },
      {
        key: "reason",
        optional: true,
        description: "Reason to mute the user (only if the first argument is the username or user id)",
      },
    ],
    description: "Permanently ban a user from a group",
    scope: "group",
    reply: "required",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      let user: User | null = null
      let reason: string | undefined

      if (repliedTo) {
        if (!repliedTo.from) {
          logger.error("BAN: no repliedTo.from field (the msg was sent in a channel)")
          return
        }
        user = repliedTo.from
        reason = [args.reasonOrUser, args.reason].filter(Boolean).join(" ") ?? undefined
      } else {
        if (!args.reasonOrUser) {
          const msg = await context.reply(
            fmt(({ b }) => b`You must specify a user to ban or reply to one of their messages`)
          )
          await ephemeral(msg)
          return
        }
        user = await getUserFromIdOrUsername(args.reasonOrUser, context)
        if (!user) {
          const msg = await context.reply(fmt(({ n }) => n`Error: cannot find this user`))
          logger.error({ user: args.reasonOrUser }, "BAN: cannot retrieve the user")
          await ephemeral(msg)
          return
        }
        reason = args.reason
      }
      const res = await Moderation.ban(user, context.chat, context.from, null, repliedTo ? [repliedTo] : [], reason)
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
        logger.error("TBAN: no repliedTo.from field (the msg was sent in a channel)")
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
      const user = await getUserFromIdOrUsername(args.username, context)
      if (!user) {
        logger.error({ user: args.username }, "UNBAN: cannot retrieve the user")
        await ephemeral(context.reply(fmt(({ n }) => [n`Error: cannot find this user`])))
        return
      }

      const res = await Moderation.unban(user, context.chat, context.from)
      if (res.isErr()) await ephemeral(context.reply(res.error.fmtError))
    },
  })
