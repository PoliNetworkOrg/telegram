import { ok, err, type Result } from "neverthrow"
import type { Context, ConversationContext } from "@/lib/managed-commands/context"
import type { User } from "grammy/types"
import { z } from "zod"
import { duration } from "@/utils/zod"
import { fmt } from "@/utils/format"
import { RestrictPermissions } from "@/utils/chat"

interface MuteProps {
  ctx: Context | ConversationContext
  from: User
  target: User
  reason?: string
  duration?: z.output<typeof duration.zod>
}

export async function mute({ ctx, from, target, reason, duration }: MuteProps): Promise<Result<string, string>> {
  if (target.id === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot mute youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot mute the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${from.username} the user @${target.username} [${target.id}] cannot be muted`))

  const until_date = duration ? Math.floor(Date.now() / 1000) + duration.parsed : undefined
  const untilDateString = until_date
    ? new Date(until_date * 1000).toLocaleString("it", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null

  await ctx.restrictChatMember(target.id, RestrictPermissions.mute, { until_date })
  return ok(
    fmt(
      ({ code, b, n }) => [
        b`🤫 Muted!`,
        n`${b`Target:`} @${target.username} [${code`${target.id}`}]`,
        n`${b`Admin:`} @${from.username} [${code`${from.id}`}]`,
        duration ? n`${b`Duration:`} ${duration.raw} (until ${untilDateString})` : undefined,
        reason ? n`${b`Reason:`} ${reason}` : undefined,
      ],
      { sep: "\n" }
    )
  )
}

interface UnmuteProps {
  ctx: Context | ConversationContext
  from: User
  targetId: number
}

export async function unmute({ ctx, targetId, from }: UnmuteProps): Promise<Result<string, string>> {
  if (targetId === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot unmute youself (smh)`))
  if (targetId === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot unmute the bot!`))

  const target = await ctx.getChatMember(targetId).catch(() => null)
  if (!target) return err(fmt(({ b }) => b`@${from.username} this user is not in this chat`))

  await ctx.restrictChatMember(target.user.id, RestrictPermissions.unmute)
  return ok(
    fmt(
      ({ code, b, n }) => [
        b`🎤 Unmuted!`,
        n`${b`Target:`} @${target.user.username} [${code`${target.user.id}`}]`,
        n`${b`Admin:`} @${from.username} [${code`${from.id}`}]`,
      ],
      { sep: "\n" }
    )
  )
}
