import type { ContextWith } from "@/utils/types"
import type { User } from "grammy/types"

import { type Result, err, ok } from "neverthrow"

import { api } from "@/backend"
import { tgLogger } from "@/bot"
import { duration } from "@/utils/duration"
import { fmt } from "@/utils/format"

interface KickProps {
  ctx: ContextWith<"chat">
  author: User
  target: User
  reason?: string
}

export async function kick({ ctx, target, author, reason }: KickProps): Promise<Result<void, string>> {
  if (target.id === author.id) return err(fmt(({ b }) => b`@${author.username} you cannot kick youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${author.username} you cannot kick the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${author.username} the user @${target.username} cannot be kicked (admin)`))

  const until_date = Math.floor(Date.now() / 1000) + duration.values.m
  await ctx.banChatMember(target.id, { until_date })
  void api.tg.auditLog.create.mutate({
    targetId: target.id,
    adminId: author.id,
    groupId: ctx.chat.id,
    until: null,
    reason,
    type: "kick",
  })
  await tgLogger.adminAction({ type: "KICK", from: author, target, reason, chat: ctx.chat })
  return ok()
}
