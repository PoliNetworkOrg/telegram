import { fmt } from "@/utils/format"
import { err, ok, type Result } from "neverthrow"
import type { User } from "grammy/types"
import type { Context, ConversationContext } from "@/lib/managed-commands/context"
import { duration } from "@/utils/zod"
import { z } from "zod"

interface BanProps {
  ctx: Context | ConversationContext
  from: User
  target: User
  reason?: string
  duration?: z.output<typeof duration.zod>
}

export async function ban({ ctx, target, from, reason, duration }: BanProps): Promise<Result<string, string>> {
  if (target.id === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot ban youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot ban the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${from.username} the user @${target.username} cannot be banned (admin)`))

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

  await ctx.banChatMember(target.id, { until_date })
  return ok(
    fmt(
      ({ code, b, n }) => [
        duration ? b`🚫 Temp Banned!` : b`🚫 Perma Banned!`,
        n`${b`Target:`} @${target.username} [${code`${target.id}`}]`,
        n`${b`Admin:`} @${from.username} [${code`${from.id}`}]`,
        duration ? n`${b`Duration:`} ${duration.raw} (until ${untilDateString})` : undefined,
        reason ? n`${b`Reason:`} ${reason}` : undefined,
      ],
      { sep: "\n" }
    )
  )
}

interface UnbanProps {
  ctx: Context | ConversationContext
  from: User
  targetId: number
}

export async function unban({ ctx, targetId, from }: UnbanProps): Promise<Result<string, string>> {
  if (targetId === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot unban youself (smh)`))
  if (targetId === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot unban the bot!`))

  const target = await ctx.getChatMember(targetId).catch(() => null)
  if (!target || target.status !== "kicked")
    return err(fmt(({ b }) => b`@${from.username} this user is not banned in this chat`))

  await ctx.unbanChatMember(target.user.id)
  return ok(
    fmt(
      ({ code, b, n }) => [
        b`✅ Unbanned!`,
        n`${b`Target:`} @${target.user.username} [${code`${target.user.id}`}]`,
        n`${b`Admin:`} @${from.username} [${code`${from.id}`}]`,
      ],
      { sep: "\n" }
    )
  )
}
