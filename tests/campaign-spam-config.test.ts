import { describe, expect, it } from "vitest"
import { normalizeCampaignText } from "@/middlewares/campaign-spam/classifier"
import { type CampaignSpamConfigInput, createCampaignSpamConfig } from "@/middlewares/campaign-spam/config"
import { CAMPAIGN_TEST_SECRET, campaignTestFingerprint } from "./fixtures/campaign-spam"

const baseInput: CampaignSpamConfigInput = {
  fingerprintSecret: CAMPAIGN_TEST_SECRET,
  quarantineDuration: "10m",
  burstWindowSeconds: 600,
  burstAuthorThreshold: 3,
  burstChatThreshold: 2,
  slowFloodWindowSeconds: 14_400,
  slowFloodAuthorThreshold: 4,
  slowFloodChatThreshold: 2,
  freshWindowSeconds: 86_400,
  evidenceRetentionSeconds: 2_592_000,
  pendingMemberSeconds: 604_800,
  profileAuthorThreshold: 3,
  confirmedSignatures: [],
  deniedUserIds: [],
  deniedHandles: [],
  deniedButtonDomains: [],
  deniedViaBotIds: [],
}

describe("campaign spam config", () => {
  it("rejects invalid thresholds and retention settings", () => {
    for (const overrides of [
      { burstChatThreshold: 1 },
      { burstAuthorThreshold: 1 },
      { slowFloodAuthorThreshold: 2 },
      { pendingMemberSeconds: Number.NaN },
      { evidenceRetentionSeconds: -1 },
      { profileAuthorThreshold: 1.5 },
    ]) {
      expect(() => createCampaignSpamConfig({ ...baseInput, ...overrides })).toThrow("must be a safe integer")
    }
  })

  it("normalizes configured signatures, handles, and domains", () => {
    const config = createCampaignSpamConfig({
      ...baseInput,
      confirmedSignatures: ["聘群演每日６００+ @Cash_Helper_47"],
      deniedUserIds: [123456789],
      deniedHandles: ["@Cash_Helper_47"],
      deniedButtonDomains: ["WWW.Bad.Example"],
      deniedViaBotIds: [42],
    })

    expect(config.confirmedSignatureHashes.size).toBe(1)
    expect(config.deniedUserHashes).toContain(campaignTestFingerprint.indicatorHash("user_id", "123456789"))
    expect(config.deniedHandleHashes).toContain(campaignTestFingerprint.handle("cash_helper_47"))
    expect(config.deniedButtonDomainHashes).toContain(campaignTestFingerprint.buttonDomain("bad.example"))
    expect(config.deniedViaBotHashes).toContain(campaignTestFingerprint.indicatorHash("via_bot", "42"))
    expect(normalizeCampaignText("聘群演每日６００+ @Cash_Helper_47")).toBe("聘群演每日#+ <mention>")
  })

  it("rejects malformed indicator lists", () => {
    expect(() => createCampaignSpamConfig({ ...baseInput, deniedHandles: [" "] })).toThrow()
    expect(() => createCampaignSpamConfig({ ...baseInput, deniedViaBotIds: [1.5] })).toThrow(
      "must contain only positive safe integers"
    )
  })

  it("rejects weak fingerprint secrets", () => {
    expect(() => createCampaignSpamConfig({ ...baseInput, fingerprintSecret: "too-short" })).toThrow(
      "at least 32 characters"
    )
  })

  it("requires the slow-flood window to exceed the fast burst window", () => {
    expect(() => createCampaignSpamConfig({ ...baseInput, slowFloodWindowSeconds: 600 })).toThrow(
      "must exceed the fast burst window"
    )
  })

  it("keeps first-post state beyond the freshness window", () => {
    expect(() => createCampaignSpamConfig({ ...baseInput, pendingMemberSeconds: 86_400 })).toThrow(
      "must exceed the freshness window"
    )
  })

  it("rejects restriction durations Telegram would interpret as permanent", () => {
    expect(() => createCampaignSpamConfig({ ...baseInput, quarantineDuration: "0m" })).toThrow(
      "at least 30 seconds and less than 366 days"
    )
    expect(() => createCampaignSpamConfig({ ...baseInput, quarantineDuration: "367d" })).toThrow(
      "at least 30 seconds and less than 366 days"
    )
    expect(() => createCampaignSpamConfig({ ...baseInput, pendingMemberSeconds: 366 * 86_400 + 1 })).toThrow(
      "must be less than 366 days"
    )
    expect(() => createCampaignSpamConfig({ ...baseInput, quarantineDuration: "366d" })).toThrow(
      "at least 30 seconds and less than 366 days"
    )
    expect(() => createCampaignSpamConfig({ ...baseInput, quarantineDuration: "365d" })).not.toThrow()
  })
})
