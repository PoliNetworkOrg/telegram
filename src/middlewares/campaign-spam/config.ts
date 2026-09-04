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
  deniedUserIds: ReadonlySet<number>
  deniedHandleHashes: ReadonlySet<string>
  deniedButtonDomainHashes: ReadonlySet<string>
  deniedViaBotIds: ReadonlySet<number>
}

export type CampaignSpamConfigInput = Omit<
  CampaignSpamConfig,
  "confirmedSignatureHashes" | "deniedUserIds" | "deniedHandleHashes" | "deniedButtonDomainHashes" | "deniedViaBotIds"
> & {
  confirmedSignaturesJson: string
  deniedUserIdsJson: string
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

/** Parses operator-managed indicators and hashes values that should not be retained in Redis. */
export function createCampaignSpamConfig(input: CampaignSpamConfigInput): CampaignSpamConfig {
  const confirmedSignatures = parseStringArray(input.confirmedSignaturesJson, "CAMPAIGN_SPAM_CONFIRMED_SIGNATURES_JSON")
  const deniedUserIds = parseNumberArray(input.deniedUserIdsJson, "CAMPAIGN_SPAM_DENIED_USER_IDS_JSON")
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
    deniedUserIds: new Set(deniedUserIds),
    deniedHandleHashes: new Set(deniedHandles.map(handleFingerprint)),
    deniedButtonDomainHashes: new Set(deniedButtonDomains.map(buttonDomainFingerprint)),
    deniedViaBotIds: new Set(deniedViaBotIds),
  }
}
