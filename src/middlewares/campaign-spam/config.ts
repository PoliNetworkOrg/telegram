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

export type CampaignSpamConfig = {
  fingerprintSecret: CampaignFingerprintSecret
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
  confirmedSignatures: readonly string[]
  deniedUserIds: readonly number[]
  deniedHandles: readonly string[]
  deniedButtonDomains: readonly string[]
  deniedViaBotIds: readonly number[]
}

/** Validates an operator-managed array of non-empty strings. */
function parseStringArray(value: readonly string[], name: string): string[] {
  return value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new TypeError(`${name} must contain only non-empty strings`)
    }
    return item
  })
}

/** Validates an operator-managed array of positive Telegram IDs. */
function parseNumberArray(value: readonly number[], name: string): number[] {
  return value.map((item) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      throw new TypeError(`${name} must contain only positive safe integers`)
    }
    return item
  })
}

/** Parses operator-managed indicators and hashes values that should not be retained in Redis. */
export function createCampaignSpamConfig(input: CampaignSpamConfigInput): CampaignSpamConfig {
  const minimums = {
    burstWindowSeconds: 60,
    burstAuthorThreshold: 2,
    burstChatThreshold: 2,
    slowFloodWindowSeconds: 600,
    slowFloodAuthorThreshold: 3,
    slowFloodChatThreshold: 2,
    freshWindowSeconds: 60,
    evidenceRetentionSeconds: 3600,
    pendingMemberSeconds: 300,
    profileAuthorThreshold: 2,
  } as const
  for (const name of Object.keys(minimums) as (keyof typeof minimums)[]) {
    if (!Number.isSafeInteger(input[name]) || input[name] < minimums[name]) {
      throw new TypeError(`${name} must be a safe integer of at least ${minimums[name]}`)
    }
  }
  if (!isTemporaryTelegramRestrictionDuration(input.quarantineDuration)) {
    throw new TypeError("quarantineDuration must be at least 30 seconds and less than 366 days")
  }
  if (input.pendingMemberSeconds > TELEGRAM_MAX_TEMPORARY_RESTRICTION_SECONDS) {
    throw new TypeError("pendingMemberSeconds must be less than 366 days")
  }
  if (input.slowFloodWindowSeconds <= input.burstWindowSeconds) {
    throw new TypeError("slowFloodWindowSeconds must exceed the fast burst window")
  }
  if (input.pendingMemberSeconds <= input.freshWindowSeconds) {
    throw new TypeError("pendingMemberSeconds must exceed the freshness window")
  }
  const fingerprintSecret = createCampaignFingerprintSecret(input.fingerprintSecret)
  const confirmedSignatures = parseStringArray(input.confirmedSignatures, "confirmedSignatures")
  const deniedUserIds = parseNumberArray(input.deniedUserIds, "deniedUserIds")
  const deniedHandles = parseStringArray(input.deniedHandles, "deniedHandles")
  const deniedButtonDomains = parseStringArray(input.deniedButtonDomains, "deniedButtonDomains")
  const deniedViaBotIds = parseNumberArray(input.deniedViaBotIds, "deniedViaBotIds")

  return {
    fingerprintSecret,
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
