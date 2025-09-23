import type { Message, User } from "grammy/types"
import { err, ok, type Result } from "neverthrow"
import type { z } from "zod"
import { api } from "@/backend"
import { tgLogger } from "@/bot"
import { RestrictPermissions } from "@/utils/chat"
import type { duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import type { ContextWith } from "@/utils/types"

interface MuteProps {
  /** The context within which the mute was dispatched, will be used to identify the chat mute */
  ctx: ContextWith<"chat">
  /** Message upon which mute is called, will be deleted */
  message: Message
  /** The user that dispatched the mute command */
  from: User
  /** The user that is gonna be muted */
  target: User
  reason?: string
  /** duration parsed with utility zod type {@link duration} */
  duration?: z.output<typeof duration.zod>
}

export async function mute({
  ctx,
  from,
  target,
  reason,
  duration,
  message,
}: MuteProps): Promise<Result<string, string>> {
  if (target.id === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot mute youself (smh)`))
  if (target.id === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot mute the bot!`))

  const chatMember = await ctx.getChatMember(target.id).catch(() => null)
  if (chatMember?.status === "administrator" || chatMember?.status === "creator")
    return err(fmt(({ b }) => b`@${from.username} the user ${fmtUser(target)} cannot be muted`))

  await ctx.restrictChatMember(target.id, RestrictPermissions.mute, { until_date: duration?.timestamp_s })
  void api.tg.auditLog.create.mutate({
    targetId: target.id,
    adminId: from.id,
    groupId: ctx.chat.id,
    until: duration?.date ?? null,
    reason,
    type: "mute",
  })

  const res = await tgLogger.moderationAction({
    action: "MUTE",
    chat: ctx.chat,
    from,
    target,
    duration,
    reason,
    message,
  })

  return ok(res)
}

interface UnmuteProps {
  ctx: ContextWith<"chat">
  from: User
  targetId: number
}

export async function unmute({ ctx, targetId, from }: UnmuteProps): Promise<Result<string, string>> {
  if (targetId === from.id) return err(fmt(({ b }) => b`@${from.username} you cannot unmute youself (smh)`))
  if (targetId === ctx.me.id) return err(fmt(({ b }) => b`@${from.username} you cannot unmute the bot!`))

  const target = await ctx.getChatMember(targetId).catch(() => null)
  if (!target) return err(fmt(({ b }) => b`@${from.username} this user is not in this chat`))

  if (target.status !== "restricted" || target.can_send_messages)
    return err(fmt(({ b }) => b`@${from.username} this user is not muted`))

  await ctx.restrictChatMember(target.user.id, RestrictPermissions.unmute)
  return ok(await tgLogger.moderationAction({ action: "UNMUTE", from, target: target.user, chat: ctx.chat }))
}
