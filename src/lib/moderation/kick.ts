import type { Context, ConversationContext } from "@/lib/managed-commands/context"
import type { User } from "grammy/types"

import { type Result, err, ok } from "neverthrow"

import { duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"

interface KickProps {
  ctx: Context | ConversationContext
  from: User
  target: User
  reason?: string
}

export async function kick({ ctx, target, from, reason }: KickProps): Promise<Result<string, string>> {
  if (target.id === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot kick youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot kick the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${from.username} the user @${target.username} cannot be kicked (admin)`))

  const until_date = Math.floor(Date.now() / 1000) + duration.values.m
  await ctx.banChatMember(target.id, { until_date })
  return ok(
    fmt(
      ({ b, n }) => [
        b`👢 Kicked!`,
        n`${b`Target:`} ${fmtUser(target)}`,
        n`${b`Admin:`} ${fmtUser(from)}`,
        reason ? n`${b`Reason:`} ${reason}` : undefined,
      ],
      { sep: "\n" }
    )
  )
}
