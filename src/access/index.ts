import type { Backend } from "@/backend"
import { logger } from "@/logger"
import type { Permission } from "./catalog"
import { type AccessEntry, DENIED, type Decision, idpDecision, NO_ACCESS } from "./decision"

export { PERMISSION, type Permission } from "./catalog"
export * from "./decision"

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

/**
 * Whether a person may run a command or press a button (RFC v3 §10.2). An unavailable decision
 * denies.
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
}): Promise<Decision> {
  return idpDecision({
    required: options.required,
    actor: () => resolveOne(options.backend, options.actorId),
    isChatAdmin: options.isChatAdmin,
  }).catch((error: unknown) => {
    const { check, actorId, chatId } = options
    logger.error({ error, check, actorId, chatId }, "[ACCESS] IdP decision unavailable, denied")
    return DENIED
  })
}
