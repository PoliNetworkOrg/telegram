import type { duration } from "@/utils/duration"
import type { ContextWith } from "@/utils/types"
import type { Message, User } from "grammy/types"
import type { z } from "zod/v4"

import { type Result, err, ok } from "neverthrow"

import { api } from "@/backend"
import { tgLogger } from "@/bot"
import { RestrictPermissions } from "@/utils/chat"
import { fmt, fmtUser } from "@/utils/format"

interface MuteProps {
  /** The context within which the mute was dispatched, will be used to identify the chat mute */
  ctx: ContextWith<"chat">
  /** Message upon which mute is called, will be deleted */
  message: Message
  /** The user that dispatched the mute command */
  author: User
  /** The user that is gonna be muted */
  target: User
  reason?: string
  /** duration parsed with utility zod type {@link duration} */
  duration?: z.output<typeof duration.zod>
}

export async function mute({
  ctx,
  author,
  target,
  reason,
  duration,
  message,
}: MuteProps): Promise<Result<void, string>> {
  if (target.id === author.id) return err(fmt(({ b }) => b`@${author.username} you cannot mute youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${author.username} you cannot mute the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${author.username} the user ${fmtUser(target)} cannot be muted`))

  await ctx.restrictChatMember(target.id, RestrictPermissions.mute, { until_date: duration?.timestamp_s })
  void api.tg.auditLog.create.mutate({
    targetId: target.id,
    adminId: author.id,
    groupId: ctx.chat.id,
    until: duration?.date ?? null,
    reason,
    type: "mute",
  })

  if (author.id === ctx.me.id)
    await tgLogger.autoModeration({
      action: "MUTE_DELETE",
      target,
      duration,
      reason,
      message,
    })
  else await tgLogger.adminAction({ type: "MUTE", from: author, target, duration, reason, chat: ctx.chat })

  await ctx.deleteMessages([message.message_id])
  return ok()
}

interface UnmuteProps {
  ctx: ContextWith<"chat">
  author: User
  targetId: number
}

export async function unmute({ ctx, targetId, author }: UnmuteProps): Promise<Result<void, string>> {
  if (targetId === author.id) return err(fmt(({ b }) => b`@${author.username} you cannot unmute youself (smh)`))
  if (targetId === ctx.me.id) return err(fmt(({ b }) => b`@${author.username} you cannot unmute the bot!`))

  const target = await ctx.getChatMember(targetId).catch(() => null)
  if (!target) return err(fmt(({ b }) => b`@${author.username} this user is not in this chat`))

  if (target.status !== "restricted" || target.can_send_messages)
    return err(fmt(({ b }) => b`@${author.username} this user is not muted`))

  await ctx.restrictChatMember(target.user.id, RestrictPermissions.unmute)
  await tgLogger.adminAction({ type: "UNMUTE", from: author, target: target.user, chat: ctx.chat })
  return ok()
}
