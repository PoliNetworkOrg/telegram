const CAMPAIGN_REVIEW_ROLES = new Set(["owner", "direttivo"])

/** Returns whether backend roles authorize network-wide campaign moderation. */
export function hasCampaignReviewRole(roles: readonly string[] | null | undefined): boolean {
  return Boolean(roles?.some((role) => CAMPAIGN_REVIEW_ROLES.has(role)))
}
