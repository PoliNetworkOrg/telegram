import { type Backend, idpConfig, legacyBackend } from "@/backend"
import { env } from "@/env"
import { logger } from "@/logger"
import type { Role } from "@/utils/types"
import type { Permission } from "./catalog"
import {
  type AccessEntry,
  DENIED,
  type DecideOptions,
  type Decision,
  type DecisionMode,
  decide,
  idpDecision,
  NO_ACCESS,
  sameAllowed,
} from "./decision"

export { PERMISSION, type Permission } from "./catalog"
export * from "./decision"

if (!idpConfig && env.IDP_DECISIONS === "enforce")
  throw new Error("IDP_DECISIONS=enforce needs the IdP configuration (IDP_PUBLIC_URL, OAUTH_BOT_*)")

/** How the bot decides who may do what (RFC v3 §13 Phase 4). */
export const decisionMode: DecisionMode = idpConfig ? env.IDP_DECISIONS : "anonymous"

/** IdP access of Telegram users, from the backend's snapshot. Unlinked users hold nothing. */
export async function resolveAccess(backend: Backend, telegramIds: number[]): Promise<Map<number, AccessEntry>> {
  const resolved = await backend.tg.access.resolve.query({ telegramIds })
  return new Map(
    telegramIds.map((id) => {
      const entry = resolved[String(id)]
      return [id, entry ? { sub: entry.sub, permissions: new Set(entry.permissions), grant: entry.grant } : NO_ACCESS]
    })
  )
}

export async function resolveOne(backend: Backend, telegramId: number): Promise<AccessEntry> {
  return (await resolveAccess(backend, [telegramId])).get(telegramId) ?? NO_ACCESS
}

/** {@link decide} in the configured mode. */
export function decideAccess<T>(options: Omit<DecideOptions<T>, "mode" | "logger">): Promise<T> {
  return decide({ ...options, mode: decisionMode, logger })
}

/**
 * Whether a person may run a command or press a button (RFC v3 §10.2), in the configured mode.
 * Once IdP decisions apply, an unavailable decision denies; legacy failures surface as before.
 */
export async function authorizeAction(options: {
  check: string
  actorId: number
  chatId?: number
  /** The update's client, acting for the person. */
  backend: Backend
  required: readonly Permission[]
  /** Set only where the chat's native admins may act too (RFC v3 §4 decision 2). */
  isChatAdmin?: () => Promise<boolean>
  legacy: () => Promise<Decision>
}): Promise<Decision> {
  return decideAccess({
    check: options.check,
    ids: { actorId: options.actorId, chatId: options.chatId },
    legacy: options.legacy,
    idp: () =>
      idpDecision({
        required: options.required,
        actor: () => resolveOne(options.backend, options.actorId),
        isChatAdmin: options.isChatAdmin,
      }),
    same: sameAllowed,
  }).catch((error: unknown) => {
    if (decisionMode !== "enforce") throw error
    logger.error({ error, check: options.check, actorId: options.actorId }, "[ACCESS] IdP decision unavailable, denied")
    return DENIED
  })
}

/**
 * Roles from the legacy `tg_permissions` table. Used only by the legacy side of a decision and the
 * legacy role commands; goes away with the switch to IdP decisions.
 */
export async function legacyRoles(userId: number): Promise<Role[]> {
  const { roles } = await legacyBackend.tg.permissions.getRoles.query({ userId })
  return roles ?? []
}
