import type { ChatMember, User } from "grammy/types"
import { api } from "@/backend"

type MessageTrustContext = {
  from: User
  chatId: number
  getAuthor(): Promise<ChatMember>
}

export type MessageTrust =
  | { status: "trusted"; role: "creator" | "admin" | "user" }
  | { status: "untrusted" }
  | { status: "unavailable"; error: unknown }

const trustChecks = new WeakMap<object, Promise<MessageTrust>>()

/** Shares one trust lookup across moderation forks handling the same update. */
export function inspectMessageTrust(ctx: MessageTrustContext): Promise<MessageTrust> {
  const cached = trustChecks.get(ctx)
  if (cached) return cached

  const result = (async (): Promise<MessageTrust> => {
    try {
      const { status } = await ctx.getAuthor()
      if (status === "creator") return { status: "trusted", role: "creator" }
      if (status === "administrator") return { status: "trusted", role: "admin" }

      const [isGroupAdmin, grant] = await Promise.all([
        api.tg.permissions.checkGroup.query({ userId: ctx.from.id, groupId: ctx.chatId }),
        api.tg.grants.checkUser.query({ userId: ctx.from.id }),
      ])
      if (isGroupAdmin) return { status: "trusted", role: "admin" }
      if (grant.isGranted) return { status: "trusted", role: "user" }
      return { status: "untrusted" }
    } catch (error) {
      return { status: "unavailable", error }
    }
  })()

  trustChecks.set(ctx, result)
  return result
}
