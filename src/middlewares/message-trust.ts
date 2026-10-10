import type { ChatMember, User } from "grammy/types"
import { decideAccess, hasPermission, PERMISSION, resolveOne } from "@/access"
import { type Backend, legacyBackend, serviceBackend } from "@/backend"

type MessageTrustContext = {
  from: User
  chatId: number
  backend: Backend
  getAuthor(): Promise<ChatMember>
}

export type MessageTrust =
  | { status: "trusted"; role: "creator" | "admin" | "user" }
  | { status: "untrusted" }
  | { status: "unavailable"; error: unknown }

type Trust = Exclude<MessageTrust, { status: "unavailable" }>

const trustChecks = new WeakMap<object, Promise<MessageTrust>>()

/** The legacy rule: an admin stored in `tg_group_admins`, or an active grant. */
async function legacyTrust(ctx: MessageTrustContext): Promise<Trust> {
  const [isGroupAdmin, grant] = await Promise.all([
    legacyBackend.tg.permissions.checkGroup.query({ userId: ctx.from.id, groupId: ctx.chatId }),
    serviceBackend.tg.grants.checkUser.query({ userId: ctx.from.id }),
  ])
  if (isGroupAdmin) return { status: "trusted", role: "admin" }
  if (grant.isGranted) return { status: "trusted", role: "user" }
  return { status: "untrusted" }
}

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
      // Native chat admins are trusted under both rules.
      const { status } = await ctx.getAuthor()
      if (status === "creator") return { status: "trusted", role: "creator" }
      if (status === "administrator") return { status: "trusted", role: "admin" }

      return await decideAccess<Trust>({
        check: "message_trust",
        ids: { actorId: ctx.from.id, chatId: ctx.chatId },
        legacy: () => legacyTrust(ctx),
        idp: () => idpTrust(ctx),
        same: (a, b) => a.status === b.status,
      })
    } catch (error) {
      return { status: "unavailable", error }
    }
  })()

  trustChecks.set(ctx, result)
  return result
}
