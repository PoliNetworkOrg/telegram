import { hasPermission, PERMISSION, resolveOne } from "@/access"
import { serviceBackend } from "@/backend"

/** Where a ban-all was requested. */
export type BanAllEntryPoint = "command" | "report_menu" | "campaign_review" | "campaign_automatic"

/**
 * Whether the target may not be banned from the whole network: `tg:immune`, at every entry point
 * (RFC v3 §10.2, §10.3). Throws when it cannot be decided, so callers can refuse to start.
 */
export async function isBanAllImmune(targetId: number): Promise<boolean> {
  return hasPermission(await resolveOne(serviceBackend, targetId), PERMISSION.immune)
}
