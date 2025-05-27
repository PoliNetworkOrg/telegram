import type { Context, ConversationContext } from "@/lib/managed-commands/context"
import type { duration } from "@/utils/duration"
import type { User } from "grammy/types"
import type { z } from "zod"

import { type Result, err, ok } from "neverthrow"

import { api } from "@/backend"
import { tgLogger } from "@/bot"
import { RestrictPermissions } from "@/utils/chat"
import { fmt, fmtUser } from "@/utils/format"

interface MuteProps {
  ctx: Context | ConversationContext
  from: User
  target: User
  reason?: string
  duration?: z.output<typeof duration.zod>
}

export async function mute({ ctx, from, target, reason, duration }: MuteProps): Promise<Result<string, string>> {
  if (!ctx.chatId || !ctx.chat) return err(fmt(({ b }) => b`@${from.username} there was an error`))
  if (target.id === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot mute youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot mute the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${from.username} the user ${fmtUser(target)} cannot be muted`))

  await ctx.restrictChatMember(target.id, RestrictPermissions.mute, { until_date: duration?.timestamp_s })
  void api.tg.auditLog.create.mutate({
    targetId: target.id,
    adminId: from.id,
    groupId: ctx.chatId,
    until: duration?.date ?? null,
    reason,
    type: "mute",
  })
  return ok(await tgLogger.adminAction({ type: "MUTE", from, target, duration, reason, chat: ctx.chat }))
}

interface UnmuteProps {
  ctx: Context | ConversationContext
  from: User
  targetId: number
}

export async function unmute({ ctx, targetId, from }: UnmuteProps): Promise<Result<string, string>> {
  if (!ctx.chatId || !ctx.chat) return err(fmt(({ b }) => b`@${from.username} there was an error`))
  if (targetId === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot unmute youself (smh)`))
  if (targetId === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot unmute the bot!`))

  const target = await ctx.getChatMember(targetId).catch(() => null)
  if (!target) return err(fmt(({ b }) => b`@${from.username} this user is not in this chat`))

  if (target.status !== "restricted" || target.can_send_messages)
    return err(fmt(({ b }) => b`@${from.username} this user is not muted`))

  await ctx.restrictChatMember(target.user.id, RestrictPermissions.unmute)
  return ok(await tgLogger.adminAction({ type: "UNMUTE", from, target: target.user, chat: ctx.chat }))
}
