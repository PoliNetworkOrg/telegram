import type { Logger } from "pino"
import { PERMISSION, type Permission } from "./catalog"

/**
 * - `anonymous`: the IdP is not configured; only the legacy role checks exist.
 * - `shadow`: both checks run, the legacy one is applied and differences are logged (RFC v3 §13).
 * - `enforce`: the IdP decision is applied.
 */
export type DecisionMode = "anonymous" | "shadow" | "enforce"

/** A Telegram user as `tg.access.resolve` describes them. */
export type AccessEntry = {
  sub: string | null
  permissions: ReadonlySet<string>
  grant: { validUntil: Date } | null
}

export const NO_ACCESS: AccessEntry = { sub: null, permissions: new Set(), grant: null }

/** Why an action was allowed; recorded as the audit `basis` (RFC v3 §10.2). */
export type DecisionBasis = "idp_permission" | "telegram_chat_admin"
export type Decision = { allowed: boolean; basis: DecisionBasis | null }

export const DENIED: Decision = { allowed: false, basis: null }

export function hasPermission(entry: AccessEntry, permission: Permission): boolean {
  if (entry.permissions.has(permission)) return true
  // RFC v3 §4.1: `tg:immune` implies `tg:trusted`, whether or not the snapshot spells it out.
  return permission === PERMISSION.trusted && entry.permissions.has(PERMISSION.immune)
}

/**
 * The IdP decision for an action: every required permission, or else, where the action allows it,
 * the native-admin shortcut of the chat (RFC v3 §4 decision 2). A failed lookup is rethrown unless
 * the shortcut applies, so callers can tell "denied" from "unknown".
 */
export async function idpDecision(options: {
  required: readonly Permission[]
  actor: () => Promise<AccessEntry>
  /** Set only for actions open to the chat's native admins. */
  isChatAdmin?: () => Promise<boolean>
}): Promise<Decision> {
  if (options.required.length === 0) return { allowed: true, basis: null }

  let failure: { error: unknown } | null = null
  try {
    const entry = await options.actor()
    if (options.required.every((permission) => hasPermission(entry, permission)))
      return { allowed: true, basis: "idp_permission" }
  } catch (error) {
    failure = { error }
  }

  if (options.isChatAdmin && (await options.isChatAdmin())) return { allowed: true, basis: "telegram_chat_admin" }
  if (failure) throw failure.error
  return DENIED
}

export type DecideOptions<T> = {
  mode: DecisionMode
  /** Names the check in logs, e.g. `command:/ban`. */
  check: string
  /** Telegram IDs that identify the case in logs. Nothing else about the people is logged. */
  ids: Record<string, number | undefined>
  legacy: () => Promise<T>
  idp: () => Promise<T>
  /** Whether two outcomes are the same decision. Default: `Object.is`. */
  same?: (legacy: T, idp: T) => boolean
  logger: Pick<Logger, "warn">
}

export const sameAllowed = (a: Decision, b: Decision) => a.allowed === b.allowed

/**
 * Runs the check the mode calls for. In shadow mode both run, the legacy outcome is returned (or
 * its error thrown) and any difference is logged; the IdP outcome is never acted on, and never
 * combined with the legacy one.
 */
export async function decide<T>(options: DecideOptions<T>): Promise<T> {
  if (options.mode === "anonymous") return options.legacy()
  if (options.mode === "enforce") return options.idp()

  const [legacy, idp] = await Promise.allSettled([options.legacy(), options.idp()])
  const context = { check: options.check, ...options.ids }
  const legacyOutcome = legacy.status === "fulfilled" ? legacy.value : "error"
  if (idp.status === "rejected") {
    options.logger.warn(
      { ...context, legacy: legacyOutcome, idpError: errorMessage(idp.reason) },
      "[ACCESS] shadow: IdP decision unavailable"
    )
  } else if (legacy.status === "rejected" || !(options.same ?? Object.is)(legacy.value, idp.value)) {
    options.logger.warn({ ...context, legacy: legacyOutcome, idp: idp.value }, "[ACCESS] shadow: decisions differ")
  }

  if (legacy.status === "rejected") throw legacy.reason
  return legacy.value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
