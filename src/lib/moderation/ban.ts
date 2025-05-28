import type { ContextWith } from "@/lib/managed-commands"
import type { duration } from "@/utils/duration"
import type { User } from "grammy/types"
import type { z } from "zod/v4"

import { type Result, err, ok } from "neverthrow"

import { api } from "@/backend"
import { tgLogger } from "@/bot"
import { fmt } from "@/utils/format"

interface BanProps {
  ctx: ContextWith<"chat">
  author: User
  target: User
  reason?: string
  duration?: z.output<typeof duration.zod>
}

export async function ban({ ctx, target, author, reason, duration }: BanProps): Promise<Result<string, string>> {
  if (target.id === author.id) return err(fmt(({ b }) => b`@${author.username} you cannot ban youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${author.username} you cannot ban the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${author.username} the user @${target.username} cannot be banned (admin)`))

  await ctx.banChatMember(target.id, { until_date: duration?.timestamp_s })
  void api.tg.auditLog.create.mutate({
    targetId: target.id,
    adminId: author.id,
    groupId: ctx.chat.id,
    until: null,
    reason,
    type: "ban",
  })
  return ok(await tgLogger.adminAction({ type: "BAN", from: author, target, duration, reason, chat: ctx.chat }))
}

interface UnbanProps {
  ctx: ContextWith<"chat">
  author: User
  targetId: number
}

export async function unban({ ctx, targetId, author }: UnbanProps): Promise<Result<string, string>> {
  if (targetId === author.id) return err(fmt(({ b }) => b`@${author.username} you cannot unban youself (smh)`))
  if (targetId === ctx.me.id) return err(fmt(({ b }) => b`@${author.username} you cannot unban the bot!`))

  const target = await ctx.getChatMember(targetId).catch(() => null)
  if (!target || target.status !== "kicked")
    return err(fmt(({ b }) => b`@${author.username} this user is not banned in this chat`))

  await ctx.unbanChatMember(target.user.id)
  return ok(await tgLogger.adminAction({ type: "UNBAN", from: author, target: target.user, chat: ctx.chat }))
}
