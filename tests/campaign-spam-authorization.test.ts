import { describe, expect, it } from "vitest"
import { hasCampaignReviewRole } from "@/middlewares/campaign-spam/authorization"

describe("campaign spam review authorization", () => {
  it("allows only roles trusted with network-wide moderation", () => {
    expect(hasCampaignReviewRole(["owner"])).toBe(true)
    expect(hasCampaignReviewRole(["direttivo"])).toBe(true)
    expect(hasCampaignReviewRole(["admin"])).toBe(false)
    expect(hasCampaignReviewRole([])).toBe(false)
    expect(hasCampaignReviewRole(undefined)).toBe(false)
  })
})
