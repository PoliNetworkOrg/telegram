import { describe, expect, it } from "vitest"
import { normalizeCampaignText } from "@/middlewares/campaign-spam/classifier"
import { type CampaignSpamConfigInput, createCampaignSpamConfig } from "@/middlewares/campaign-spam/config"
import { CAMPAIGN_TEST_SECRET, campaignTestFingerprint } from "./fixtures/campaign-spam"

const baseInput: CampaignSpamConfigInput = {
  fingerprintSecret: CAMPAIGN_TEST_SECRET,
  mode: "observe",
  joinGate: false,
  quarantineDuration: "10m",
  burstWindowSeconds: 600,
  burstAuthorThreshold: 3,
  burstChatThreshold: 2,
  freshWindowSeconds: 600,
  evidenceRetentionSeconds: 2_592_000,
  pendingMemberSeconds: 86_400,
  profileAuthorThreshold: 3,
  confirmedSignaturesJson: "[]",
  deniedUserIdsJson: "[]",
  deniedHandlesJson: "[]",
  deniedButtonDomainsJson: "[]",
  deniedViaBotIdsJson: "[]",
}

describe("campaign spam config", () => {
  it("normalizes configured signatures, handles, and domains", () => {
    const config = createCampaignSpamConfig({
      ...baseInput,
      confirmedSignaturesJson: JSON.stringify(["聘群演每日６００+ @Cash_Helper_47"]),
      deniedUserIdsJson: "[123456789]",
      deniedHandlesJson: JSON.stringify(["@Cash_Helper_47"]),
      deniedButtonDomainsJson: JSON.stringify(["WWW.Bad.Example"]),
      deniedViaBotIdsJson: "[42]",
    })

    expect(config.confirmedSignatureHashes.size).toBe(1)
    expect(config.deniedUserHashes).toContain(campaignTestFingerprint.indicatorHash("user_id", "123456789"))
    expect(config.deniedHandleHashes).toContain(campaignTestFingerprint.handle("cash_helper_47"))
    expect(config.deniedButtonDomainHashes).toContain(campaignTestFingerprint.buttonDomain("bad.example"))
    expect(config.deniedViaBotHashes).toContain(campaignTestFingerprint.indicatorHash("via_bot", "42"))
    expect(normalizeCampaignText("聘群演每日６００+ @Cash_Helper_47")).toBe("聘群演每日#+ <mention>")
  })

  it("rejects malformed indicator lists", () => {
    expect(() => createCampaignSpamConfig({ ...baseInput, deniedHandlesJson: "not-json" })).toThrow()
    expect(() => createCampaignSpamConfig({ ...baseInput, deniedViaBotIdsJson: '["42"]' })).toThrow(
      "must contain only positive safe integers"
    )
  })

  it("rejects weak fingerprint secrets", () => {
    expect(() => createCampaignSpamConfig({ ...baseInput, fingerprintSecret: "too-short" })).toThrow(
      "at least 32 characters"
    )
  })
})
