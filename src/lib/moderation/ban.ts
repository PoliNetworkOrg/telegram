import type { Context, ConversationContext } from "@/lib/managed-commands/context"
import type { duration } from "@/utils/duration"
import type { User } from "grammy/types"
import type { z } from "zod"

import { type Result, err, ok } from "neverthrow"

import { api } from "@/backend"
import { tgLogger } from "@/bot"
import { fmt } from "@/utils/format"

interface BanProps {
  ctx: Context | ConversationContext
  from: User
  target: User
  reason?: string
  duration?: z.output<typeof duration.zod>
}

export async function ban({ ctx, target, from, reason, duration }: BanProps): Promise<Result<string, string>> {
  if (!ctx.chatId || !ctx.chat) return err(fmt(({ b }) => b`@${from.username} there was an error`))
  if (target.id === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot ban youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot ban the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${from.username} the user @${target.username} cannot be banned (admin)`))

  await ctx.banChatMember(target.id, { until_date: duration?.timestamp_s })
  void api.tg.auditLog.create.mutate({
    targetId: target.id,
    adminId: from.id,
    groupId: ctx.chatId,
    until: null,
    reason,
    type: "ban",
  })
  return ok(await tgLogger.adminAction({ type: "BAN", from, target, duration, reason, chat: ctx.chat }))
}

interface UnbanProps {
  ctx: Context | ConversationContext
  from: User
  targetId: number
}

export async function unban({ ctx, targetId, from }: UnbanProps): Promise<Result<string, string>> {
  if (!ctx.chatId || !ctx.chat) return err(fmt(({ b }) => b`@${from.username} there was an error`))
  if (targetId === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot unban youself (smh)`))
  if (targetId === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot unban the bot!`))

  const target = await ctx.getChatMember(targetId).catch(() => null)
  if (!target || target.status !== "kicked")
    return err(fmt(({ b }) => b`@${from.username} this user is not banned in this chat`))

  await ctx.unbanChatMember(target.user.id)
  return ok(await tgLogger.adminAction({ type: "UNBAN", from, target: target.user, chat: ctx.chat }))
}
