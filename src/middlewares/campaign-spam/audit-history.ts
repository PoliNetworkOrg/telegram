export type BanAllAuditEntry = {
  type: string
  status?: string
}

/** Returns the state established by the latest non-failed BanAll or UnbanAll audit entry. */
export function hasActiveBanAll(entries: readonly BanAllAuditEntry[]): boolean {
  const latest = entries.find(
    (entry) => (entry.type === "ban_all" || entry.type === "unban_all") && entry.status !== "failed"
  )
  return latest?.type === "ban_all"
}
