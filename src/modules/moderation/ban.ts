import type { Message, User } from "grammy/types"
import { err, ok, type Result } from "neverthrow"
import type { z } from "zod"
import { api } from "@/backend"
import { modules } from "@/modules"
import type { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"
import type { ContextWith } from "@/utils/types"

interface BanProps {
  ctx: ContextWith<"chat">
  message?: Message
  from: User
  target: User
  reason?: string
  duration?: z.output<typeof duration.zod>
}

export async function ban({ ctx, target, from, reason, duration, message }: BanProps): Promise<Result<string, string>> {
  if (target.id === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot ban youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot ban the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${from.username} the user @${target.username} cannot be banned (admin)`))

  await ctx.banChatMember(target.id, { until_date: duration?.timestamp_s })
  void api.tg.auditLog.create.mutate({
    targetId: target.id,
    adminId: from.id,
    groupId: ctx.chat.id,
    until: null,
    reason,
    type: "ban",
  })
  return ok(
    await modules
      .get("tgLogger")
      .moderationAction({ action: "BAN", from, message, target, duration, reason, chat: ctx.chat })
  )
}

interface UnbanProps {
  ctx: ContextWith<"chat">
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
    await modules.get("tgLogger").moderationAction({ action: "UNBAN", from: from, target: target.user, chat: ctx.chat })
  )
}
