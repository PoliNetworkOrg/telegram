import type { Message, User } from "grammy/types"
import { err, ok, type Result } from "neverthrow"
import { api } from "@/backend"
import { modules } from "@/modules"
import { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"
import type { ContextWith } from "@/utils/types"

interface KickProps {
  ctx: ContextWith<"chat">
  from: User
  target: User
  message?: Message
  reason?: string
}

export async function kick({ ctx, target, from, reason, message }: KickProps): Promise<Result<string, string>> {
  if (target.id === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot kick youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot kick the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${from.username} the user @${target.username} cannot be kicked (admin)`))

  const until_date = Math.floor(Date.now() / 1000) + duration.values.m
  await ctx.banChatMember(target.id, { until_date })
  void api.tg.auditLog.create.mutate({
    targetId: target.id,
    adminId: from.id,
    groupId: ctx.chat.id,
    until: null,
    reason,
    type: "kick",
  })
  return ok(
    await modules.get("tgLogger").moderationAction({ action: "KICK", from, target, reason, message, chat: ctx.chat })
  )
}
