import { logger } from "@/logger"
import { _commandsBase } from "./_base"
import { RestrictPermissions } from "@/utils/chat"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { z } from "zod"
import { asyncDelay } from "@/utils/timer"
import { wait } from "@/utils/wait"

const DURATIONS = ["s", "m", "h", "d", "w"] as const
const Durations: Record<Duration, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
}
type Duration = (typeof DURATIONS)[number]
const durationRegex = new RegExp(`(\\d+)[${DURATIONS.join("")}]`)

_commandsBase
  .createCommand({
    trigger: "mute",
    args: [
      {
        key: "duration",
        type: z
          .string()
          .regex(durationRegex)
          .transform((a) => ({ parsed: parseInt(a.slice(0, -1)) * Durations[a.slice(-1) as Duration], raw: a })),
        optional: false,
        description: "How long to mutate the user",
      },
      { key: "reason", optional: true, description: "Optional reason to mutate the user" },
    ],
    description: "Mute a user from a group (deletes the message you reply to)",
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
        const msg = await context.reply(fmt(({ b }) => b`There was an error, try again`))
        await wait(5000)
        await msg.delete()
        return
      }

      if (repliedTo.from.id === context.from?.id) {
        const msg = await context.reply(fmt(({ b }) => b`@${context.from?.username} you cannot mute youself (smh)`))
        await wait(5000)
        await msg.delete()
        return
      }

      if (repliedTo.from.id === context.me.id) {
        const msg = await context.reply(fmt(({ b }) => b`@${context.from?.username} you cannot mute the bot!`))
        await wait(5000)
        await msg.delete()
        return
      }

      const chatMember = await context.getChatMember(repliedTo.from.id).catch(() => null)
      if (chatMember?.status === "administrator" || chatMember?.status === "creator") {
        const msg = await context.reply(
          fmt(({ b }) => b`@${context.from?.username} the user @${repliedTo.from?.username} cannot be muted`)
        )
        await wait(5000)
        await msg.delete()
        return
      }

      const until_date = Math.floor(Date.now() / 1000) + args.duration.parsed
      const untilDateString = new Date(until_date * 1000).toLocaleString("it", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })

      const logMsg = fmt(
        ({ code, b, n }) => [
          b`🤫 Muted!`,
          n`${b`Target:`} @${repliedTo.from?.username} [${code`${repliedTo.from?.id}`}]`,
          n`${b`Admin:`} @${context.from?.username} [${code`${context.from?.id}`}]`,
          n`${b`Duration:`} ${args.duration.raw} (until ${untilDateString})`,
          args.reason ? n`${b`Reason:`} ${args.reason}` : "",
        ],
        { sep: "\n" }
      )

      // await context.deleteMessages([repliedTo.message_id])
      await context.restrictChatMember(repliedTo.from.id, RestrictPermissions.mute, { until_date })
      await context.reply(logMsg)
      logger.debug(
        `mute: user ${repliedTo.from.username} [${repliedTo.from.id}] has been muted for ${args.duration.raw} (until ${untilDateString}) in chat ${repliedTo.chat.title} [${repliedTo.chat.id}] by ${context.from?.username} [${context.from?.id}]`
      )
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
      const userId = args.username.startsWith("@") ? await getTelegramId(args.username) : parseInt(args.username)
      if (!userId) {
        logger.debug(`unmute: no userId for username ${args.username}`)
        return
      }

      const chatMember = await context.getChatMember(userId).catch(() => null)
      if (!chatMember) {
        logger.debug(`unmute: no chatMember for userId ${userId}`)
        return
      }

      const logMsg = fmt(
        ({ code, b, n }) => [
          b`🎤 Unmuted!`,
          n`${b`Target:`} @${chatMember.user.username} [${code`${chatMember.user.id}`}]`,
          n`${b`Admin:`} @${context.from?.username} [${code`${context.from?.id}`}]`,
        ],
        { sep: "\n" }
      )

      await context.restrictChatMember(chatMember.user.id, RestrictPermissions.unmute)
      await context.reply(logMsg)
      logger.debug(
        `unmute: user ${chatMember.user.username} [${chatMember.user.id}] has been unmuted in chat ${context.chat.title} [${context.chat.id}]`
      )
    },
  })
