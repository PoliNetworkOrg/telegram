import { mute, unmute } from "@/lib/moderation"
import { logger } from "@/logger"
import { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { wait } from "@/utils/wait"

import { _commandsBase } from "./_base"

_commandsBase
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
      allowedGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      await context.deleteMessage()
      if (!repliedTo.from) {
        logger.error("tmute: no repliedTo.from field (the msg was sent in a channel)")
        return
      }

      const res = await mute({
        ctx: context,
        target: repliedTo.from,
        message: repliedTo,
        author: context.from,
        duration: args.duration,
        reason: args.reason,
      })

      if (res.isErr()) {
        const msg = await context.reply(res.error)
        await wait(5000)
        await msg.delete()
        return
      }

      await context.reply(res.value)
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
      allowedGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      await context.deleteMessage()
      if (!repliedTo.from) {
        logger.error("mute: no repliedTo.from field (the msg was sent in a channel)")
        return
      }

      const res = await mute({
        ctx: context,
        target: repliedTo.from,
        message: repliedTo,
        author: context.from,
        reason: args.reason,
      })

      if (res.isErr()) {
        const msg = await context.reply(res.error)
        await wait(5000)
        await msg.delete()
        return
      }

      await context.reply(res.value)
    },
  })
  .createCommand({
    trigger: "unmute",
    args: [{ key: "username", optional: false, description: "Username (or user id) to unmute" }],
    description: "Unmute a user from a group",
    scope: "group",
    permissions: {
      excludedRoles: ["creator"],
      allowedGroupAdmins: true,
    },
    handler: async ({ args, context }) => {
      await context.deleteMessage()
      const userId = args.username.startsWith("@") ? await getTelegramId(args.username) : parseInt(args.username, 10)
      if (!userId) {
        logger.debug(`unmute: no userId for username ${args.username}`)
        const msg = await context.reply(fmt(({ b }) => b`@${context.from.username} user not found`))
        await wait(5000)
        await msg.delete()
        return
      }

      const res = await unmute({ ctx: context, author: context.from, targetId: userId })
      if (res.isErr()) {
        const msg = await context.reply(res.error)
        await wait(5000)
        await msg.delete()
        return
      }

      await context.reply(res.value)
    },
  })
