import { PERMISSION, type Permission } from "./catalog"

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
