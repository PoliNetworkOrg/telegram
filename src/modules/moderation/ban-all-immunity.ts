import { decideAccess, hasPermission, legacyRoles, PERMISSION, resolveOne } from "@/access"
import { serviceBackend } from "@/backend"
import type { Role } from "@/utils/types"

const BYPASS_ROLES: Role[] = ["president", "owner", "direttivo"]

/** Where a ban-all was requested. Only `/ban_all` checked immunity before the IdP migration. */
export type BanAllEntryPoint = "command" | "report_menu" | "campaign_review" | "campaign_automatic"

/**
 * Whether the target may not be banned from the whole network: `tg:immune`, at every entry point
 * (RFC v3 §10.2, §10.3). Throws when it cannot be decided, so callers can refuse to start.
 */
export async function isBanAllImmune(targetId: number, entryPoint: BanAllEntryPoint): Promise<boolean> {
  return decideAccess({
    check: `ban_all_immunity:${entryPoint}`,
    ids: { targetId },
    legacy: async () =>
      entryPoint === "command" && (await legacyRoles(targetId)).some((role) => BYPASS_ROLES.includes(role)),
    idp: async () => hasPermission(await resolveOne(serviceBackend, targetId), PERMISSION.immune),
  })
}
