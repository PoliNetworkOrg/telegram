import type { ChatMember, User } from "grammy/types"
import { hasPermission, PERMISSION, resolveOne } from "@/access"
import type { Backend } from "@/backend"

type MessageTrustContext = {
  from: User
  backend: Backend
  getAuthor(): Promise<ChatMember>
}

export type MessageTrust =
  | { status: "trusted"; role: "creator" | "admin" | "user" }
  | { status: "untrusted" }
  | { status: "unavailable"; error: unknown }

type Trust = Exclude<MessageTrust, { status: "unavailable" }>

const trustChecks = new WeakMap<object, Promise<MessageTrust>>()

/** RFC v3 §10.2: `tg:trusted` (implied by `tg:immune`) or an active grant. */
async function idpTrust(ctx: MessageTrustContext): Promise<Trust> {
  const entry = await resolveOne(ctx.backend, ctx.from.id)
  if (hasPermission(entry, PERMISSION.trusted) || entry.grant !== null) return { status: "trusted", role: "user" }
  return { status: "untrusted" }
}

/** Shares one trust lookup across moderation forks handling the same update. */
export function inspectMessageTrust(ctx: MessageTrustContext): Promise<MessageTrust> {
  const cached = trustChecks.get(ctx)
  if (cached) return cached

  const result = (async (): Promise<MessageTrust> => {
    try {
      // RFC v3 §10.2: native chat admins are trusted.
      const { status } = await ctx.getAuthor()
      if (status === "creator") return { status: "trusted", role: "creator" }
      if (status === "administrator") return { status: "trusted", role: "admin" }

      return await idpTrust(ctx)
    } catch (error) {
      return { status: "unavailable", error }
    }
  })()

  trustChecks.set(ctx, result)
  return result
}
