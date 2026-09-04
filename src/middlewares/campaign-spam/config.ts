import { buttonDomainFingerprint, campaignIndicatorHash, handleFingerprint, normalizeCampaignText } from "./classifier"

export type CampaignSpamMode = "off" | "observe" | "quarantine" | "enforce"

export type CampaignSpamConfig = {
  mode: CampaignSpamMode
  joinGate: boolean
  quarantineDuration: string
  burstWindowSeconds: number
  burstAuthorThreshold: number
  burstChatThreshold: number
  freshWindowSeconds: number
  evidenceRetentionSeconds: number
  pendingMemberSeconds: number
  profileAuthorThreshold: number
  confirmedSignatureHashes: ReadonlySet<string>
  deniedHandleHashes: ReadonlySet<string>
  deniedButtonDomainHashes: ReadonlySet<string>
  deniedViaBotIds: ReadonlySet<number>
}

export type CampaignSpamConfigInput = Omit<
  CampaignSpamConfig,
  "confirmedSignatureHashes" | "deniedHandleHashes" | "deniedButtonDomainHashes" | "deniedViaBotIds"
> & {
  confirmedSignaturesJson: string
  deniedHandlesJson: string
  deniedButtonDomainsJson: string
  deniedViaBotIdsJson: string
}

function parseJsonArray(value: string, name: string): unknown[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new TypeError(`${name} must be a JSON array`)
  return parsed
}

function parseStringArray(value: string, name: string): string[] {
  return parseJsonArray(value, name).map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new TypeError(`${name} must contain only non-empty strings`)
    }
    return item
  })
}

function parseNumberArray(value: string, name: string): number[] {
  return parseJsonArray(value, name).map((item) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      throw new TypeError(`${name} must contain only positive safe integers`)
    }
    return item
  })
}

export function createCampaignSpamConfig(input: CampaignSpamConfigInput): CampaignSpamConfig {
  const confirmedSignatures = parseStringArray(input.confirmedSignaturesJson, "CAMPAIGN_SPAM_CONFIRMED_SIGNATURES_JSON")
  const deniedHandles = parseStringArray(input.deniedHandlesJson, "CAMPAIGN_SPAM_DENIED_HANDLES_JSON")
  const deniedButtonDomains = parseStringArray(
    input.deniedButtonDomainsJson,
    "CAMPAIGN_SPAM_DENIED_BUTTON_DOMAINS_JSON"
  )
  const deniedViaBotIds = parseNumberArray(input.deniedViaBotIdsJson, "CAMPAIGN_SPAM_DENIED_VIA_BOT_IDS_JSON")

  return {
    mode: input.mode,
    joinGate: input.joinGate,
    quarantineDuration: input.quarantineDuration,
    burstWindowSeconds: input.burstWindowSeconds,
    burstAuthorThreshold: input.burstAuthorThreshold,
    burstChatThreshold: input.burstChatThreshold,
    freshWindowSeconds: input.freshWindowSeconds,
    evidenceRetentionSeconds: input.evidenceRetentionSeconds,
    pendingMemberSeconds: input.pendingMemberSeconds,
    profileAuthorThreshold: input.profileAuthorThreshold,
    confirmedSignatureHashes: new Set(
      confirmedSignatures.map((signature) => campaignIndicatorHash("signature", normalizeCampaignText(signature)))
    ),
    deniedHandleHashes: new Set(deniedHandles.map(handleFingerprint)),
    deniedButtonDomainHashes: new Set(deniedButtonDomains.map(buttonDomainFingerprint)),
    deniedViaBotIds: new Set(deniedViaBotIds),
  }
}
