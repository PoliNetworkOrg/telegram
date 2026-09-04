import { describe, expect, it } from "vitest"
import {
  buttonDomainFingerprint,
  handleFingerprint,
  normalizeCampaignText,
} from "@/middlewares/campaign-spam/classifier"
import { type CampaignSpamConfigInput, createCampaignSpamConfig } from "@/middlewares/campaign-spam/config"

const baseInput: CampaignSpamConfigInput = {
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
  deniedHandlesJson: "[]",
  deniedButtonDomainsJson: "[]",
  deniedViaBotIdsJson: "[]",
}

describe("campaign spam config", () => {
  it("normalizes configured signatures, handles, and domains", () => {
    const config = createCampaignSpamConfig({
      ...baseInput,
      confirmedSignaturesJson: JSON.stringify(["聘群演每日６００+ @Cash_Helper_47"]),
      deniedHandlesJson: JSON.stringify(["@Cash_Helper_47"]),
      deniedButtonDomainsJson: JSON.stringify(["WWW.Bad.Example"]),
      deniedViaBotIdsJson: "[42]",
    })

    expect(config.confirmedSignatureHashes.size).toBe(1)
    expect(config.deniedHandleHashes).toContain(handleFingerprint("cash_helper_47"))
    expect(config.deniedButtonDomainHashes).toContain(buttonDomainFingerprint("bad.example"))
    expect(config.deniedViaBotIds).toContain(42)
    expect(normalizeCampaignText("聘群演每日６００+ @Cash_Helper_47")).toBe("聘群演每日#+ <mention>")
  })

  it("rejects malformed indicator lists", () => {
    expect(() => createCampaignSpamConfig({ ...baseInput, deniedHandlesJson: "not-json" })).toThrow()
    expect(() => createCampaignSpamConfig({ ...baseInput, deniedViaBotIdsJson: '["42"]' })).toThrow(
      "must contain only positive safe integers"
    )
  })
})
