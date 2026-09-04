import {
  isTemporaryTelegramRestrictionDuration,
  TELEGRAM_MAX_TEMPORARY_RESTRICTION_SECONDS,
} from "@/utils/telegram-restriction"
import {
  buttonDomainFingerprint,
  type CampaignFingerprintSecret,
  campaignIndicatorHash,
  createCampaignFingerprintSecret,
  handleFingerprint,
  normalizeCampaignText,
} from "./classifier"

export type CampaignSpamMode = "off" | "observe" | "quarantine" | "enforce"

export type CampaignSpamConfig = {
  fingerprintSecret: CampaignFingerprintSecret
  mode: CampaignSpamMode
  joinGate: boolean
  quarantineDuration: string
  burstWindowSeconds: number
  burstAuthorThreshold: number
  burstChatThreshold: number
  slowFloodWindowSeconds: number
  slowFloodAuthorThreshold: number
  slowFloodChatThreshold: number
  freshWindowSeconds: number
  evidenceRetentionSeconds: number
  pendingMemberSeconds: number
  profileAuthorThreshold: number
  confirmedSignatureHashes: ReadonlySet<string>
  deniedUserHashes: ReadonlySet<string>
  deniedHandleHashes: ReadonlySet<string>
  deniedButtonDomainHashes: ReadonlySet<string>
  deniedViaBotHashes: ReadonlySet<string>
}

export type CampaignSpamConfigInput = Omit<
  CampaignSpamConfig,
  | "fingerprintSecret"
  | "confirmedSignatureHashes"
  | "deniedUserHashes"
  | "deniedHandleHashes"
  | "deniedButtonDomainHashes"
  | "deniedViaBotHashes"
> & {
  fingerprintSecret: string
  confirmedSignaturesJson: string
  deniedUserIdsJson: string
  deniedHandlesJson: string
  deniedButtonDomainsJson: string
  deniedViaBotIdsJson: string
}

/** Parses a JSON setting and rejects non-array values. */
function parseJsonArray(value: string, name: string): unknown[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new TypeError(`${name} must be a JSON array`)
  return parsed
}

/** Validates an operator-managed array of non-empty strings. */
function parseStringArray(value: string, name: string): string[] {
  return parseJsonArray(value, name).map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new TypeError(`${name} must contain only non-empty strings`)
    }
    return item
  })
}

/** Validates an operator-managed array of positive Telegram IDs. */
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
  if (!isTemporaryTelegramRestrictionDuration(input.quarantineDuration)) {
    throw new TypeError("CAMPAIGN_SPAM_QUARANTINE_DURATION must be at least 30 seconds and less than 366 days")
  }
  if (input.pendingMemberSeconds > TELEGRAM_MAX_TEMPORARY_RESTRICTION_SECONDS) {
    throw new TypeError("CAMPAIGN_SPAM_PENDING_MEMBER_SECONDS must be less than 366 days")
  }
  if (input.slowFloodWindowSeconds <= input.burstWindowSeconds) {
    throw new TypeError("CAMPAIGN_SPAM_SLOW_FLOOD_WINDOW_SECONDS must exceed the fast burst window")
  }
  if (input.pendingMemberSeconds <= input.freshWindowSeconds) {
    throw new TypeError("CAMPAIGN_SPAM_PENDING_MEMBER_SECONDS must exceed the freshness window")
  }
  const fingerprintSecret = createCampaignFingerprintSecret(input.fingerprintSecret)
  const confirmedSignatures = parseStringArray(input.confirmedSignaturesJson, "CAMPAIGN_SPAM_CONFIRMED_SIGNATURES_JSON")
  const deniedUserIds = parseNumberArray(input.deniedUserIdsJson, "CAMPAIGN_SPAM_DENIED_USER_IDS_JSON")
  const deniedHandles = parseStringArray(input.deniedHandlesJson, "CAMPAIGN_SPAM_DENIED_HANDLES_JSON")
  const deniedButtonDomains = parseStringArray(
    input.deniedButtonDomainsJson,
    "CAMPAIGN_SPAM_DENIED_BUTTON_DOMAINS_JSON"
  )
  const deniedViaBotIds = parseNumberArray(input.deniedViaBotIdsJson, "CAMPAIGN_SPAM_DENIED_VIA_BOT_IDS_JSON")

  return {
    fingerprintSecret,
    mode: input.mode,
    joinGate: input.joinGate,
    quarantineDuration: input.quarantineDuration,
    burstWindowSeconds: input.burstWindowSeconds,
    burstAuthorThreshold: input.burstAuthorThreshold,
    burstChatThreshold: input.burstChatThreshold,
    slowFloodWindowSeconds: input.slowFloodWindowSeconds,
    slowFloodAuthorThreshold: input.slowFloodAuthorThreshold,
    slowFloodChatThreshold: input.slowFloodChatThreshold,
    freshWindowSeconds: input.freshWindowSeconds,
    evidenceRetentionSeconds: input.evidenceRetentionSeconds,
    pendingMemberSeconds: input.pendingMemberSeconds,
    profileAuthorThreshold: input.profileAuthorThreshold,
    confirmedSignatureHashes: new Set(
      confirmedSignatures.map((signature) =>
        campaignIndicatorHash("signature", normalizeCampaignText(signature), fingerprintSecret)
      )
    ),
    deniedUserHashes: new Set(
      deniedUserIds.map((userId) => campaignIndicatorHash("user_id", String(userId), fingerprintSecret))
    ),
    deniedHandleHashes: new Set(deniedHandles.map((handle) => handleFingerprint(handle, fingerprintSecret))),
    deniedButtonDomainHashes: new Set(
      deniedButtonDomains.map((domain) => buttonDomainFingerprint(domain, fingerprintSecret))
    ),
    deniedViaBotHashes: new Set(
      deniedViaBotIds.map((userId) => campaignIndicatorHash("via_bot", String(userId), fingerprintSecret))
    ),
  }
}
