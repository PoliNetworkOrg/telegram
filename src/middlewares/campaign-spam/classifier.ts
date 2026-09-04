import { nanohash } from "@/utils/crypto"

const HAN_PATTERN = /\p{Script=Han}/u
const MENTION_PATTERN = /@[\p{L}\p{N}_]{3,}/gu
const CONTROL_PATTERN = /\p{Cc}/gu
const FORMAT_PATTERN = /\p{Cf}/gu
const NUMBER_PATTERN = /\p{N}+/gu
const SPACE_PATTERN = /\s+/g

export const CAMPAIGN_SPAM_MODEL_VERSION = "deterministic-v1"

export type CampaignSpamDecision = "allow" | "quarantine" | "ban_all"

export type CampaignSpamReason =
  | "confirmed_signature"
  | "confirmed_profile"
  | "denied_user"
  | "fresh_user"
  | "global_burst"
  | "han_with_mention"
  | "inline_keyboard"
  | "known_button_domain"
  | "known_handle"
  | "known_via_bot"
  | "partial_profile"
  | "via_bot"

export type CampaignJoinClassification = {
  decision: "decline" | "restrict"
  reviewReason?: Extract<CampaignSpamReason, "confirmed_profile" | "denied_user" | "partial_profile">
}

export type CampaignMessageInput = {
  text: string
  entityTypes?: readonly string[]
  mentionedUserIds?: readonly number[]
  buttonUrls?: readonly string[]
  hasInlineKeyboard?: boolean
  viaBotId?: number
  viaBotUsername?: string
}

export type CampaignMessageSignals = {
  normalizedText: string
  signatureHash: string
  hasHan: boolean
  hasMention: boolean
  mentionedHandleHashes: string[]
  mentionedUserIdHashes: string[]
  buttonUrlHashes: string[]
  buttonDomainHashes: string[]
  entityTypes: string[]
  hasInlineKeyboard: boolean
  viaBotId?: number
  viaBotUsernameHash?: string
}

export type CampaignReputationSnapshot = {
  confirmedSignature: boolean
  deniedUser: boolean
  freshUser: boolean
  globalBurst: boolean
  knownButtonDomain: boolean
  knownHandle: boolean
  knownViaBot: boolean
  distinctAuthors: number
  distinctChats: number
}

export type CampaignClassification = {
  decision: CampaignSpamDecision
  reasons: CampaignSpamReason[]
}

export const EMPTY_CAMPAIGN_REPUTATION: CampaignReputationSnapshot = {
  confirmedSignature: false,
  deniedUser: false,
  freshUser: false,
  globalBurst: false,
  knownButtonDomain: false,
  knownHandle: false,
  knownViaBot: false,
  distinctAuthors: 0,
  distinctChats: 0,
}

/** Redacts rotating handles and digits so campaign variants share one signature. */
export function normalizeCampaignText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(FORMAT_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(MENTION_PATTERN, "<mention>")
    .replace(NUMBER_PATTERN, "#")
    .replace(SPACE_PATTERN, " ")
    .trim()
}

/** Normalizes only Unicode, case, controls, and whitespace for exact profile comparison. */
export function normalizeProfileName(firstName: string, lastName?: string): string {
  return `${firstName} ${lastName ?? ""}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(FORMAT_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(SPACE_PATTERN, " ")
    .trim()
}

/** Creates a namespaced SHA-256-derived identifier without retaining the source value. */
export function campaignIndicatorHash(
  kind: "button_domain" | "button_url" | "handle" | "mention_user" | "profile" | "signature",
  value: string
): string {
  return nanohash(`${kind}:${value}`, 24)
}

/** Returns the stable hash used for exact display-name reputation. */
export function profileFingerprint(firstName: string, lastName?: string): string {
  return campaignIndicatorHash("profile", normalizeProfileName(firstName, lastName))
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").normalize("NFKC").toLowerCase()
}

/** Returns the stable hash used for case-insensitive Telegram handles. */
export function handleFingerprint(handle: string): string {
  return campaignIndicatorHash("handle", normalizeHandle(handle))
}

function normalizedButtonUrl(url: string): string | null {
  try {
    return new URL(url.trim()).toString()
  } catch {
    return null
  }
}

function buttonDomain(url: string): string | null {
  const normalizedUrl = normalizedButtonUrl(url)
  if (!normalizedUrl) return null
  const parsed = new URL(normalizedUrl)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  return parsed.hostname.toLowerCase().replace(/^www\./, "")
}

/** Hashes a normalized full button URL, including its path and query. */
export function buttonUrlFingerprint(url: string): string {
  return campaignIndicatorHash("button_url", normalizedButtonUrl(url) ?? url.trim().normalize("NFKC"))
}

/** Hashes a normalized hostname for domain-level button matching. */
export function buttonDomainFingerprint(domain: string): string {
  const trimmed = domain.trim()
  const normalizedDomain = buttonDomain(trimmed.includes("://") ? trimmed : `https://${trimmed}`) ?? trimmed
  return campaignIndicatorHash("button_domain", normalizedDomain.toLowerCase().replace(/^www\./, ""))
}

/** Converts message text and Telegram metadata into privacy-preserving classifier signals. */
export function extractCampaignSignals(input: CampaignMessageInput): CampaignMessageSignals {
  const normalizedText = normalizeCampaignText(input.text)
  const entityTypes = [...new Set(input.entityTypes ?? [])].sort()
  const mentionedHandles = [...input.text.matchAll(MENTION_PATTERN)].map(([handle]) => handle)
  const hasEntityMention = entityTypes.includes("mention") || entityTypes.includes("text_mention")
  const mentionedUserIds = [...new Set(input.mentionedUserIds ?? [])]
  const buttonUrls = (input.buttonUrls ?? []).map(normalizedButtonUrl).filter((url) => url !== null)
  const domains = (input.buttonUrls ?? []).map(buttonDomain).filter((domain) => domain !== null)

  return {
    normalizedText,
    signatureHash: campaignIndicatorHash("signature", normalizedText),
    hasHan: HAN_PATTERN.test(normalizedText),
    hasMention: hasEntityMention || mentionedHandles.length > 0,
    mentionedHandleHashes: [...new Set(mentionedHandles.map(handleFingerprint))],
    mentionedUserIdHashes: mentionedUserIds.map((userId) => campaignIndicatorHash("mention_user", String(userId))),
    buttonUrlHashes: [...new Set(buttonUrls.map(buttonUrlFingerprint))],
    buttonDomainHashes: [...new Set(domains.map(buttonDomainFingerprint))],
    entityTypes,
    hasInlineKeyboard: input.hasInlineKeyboard ?? (input.buttonUrls?.length ?? 0) > 0,
    viaBotId: input.viaBotId,
    viaBotUsernameHash: input.viaBotUsername ? handleFingerprint(input.viaBotUsername) : undefined,
  }
}

/** Applies the auditable allow, quarantine, and BanAll decision rules. */
export function classifyCampaignMessage(
  signals: CampaignMessageSignals,
  reputation: CampaignReputationSnapshot
): CampaignClassification {
  const banReasons: CampaignSpamReason[] = []
  if (reputation.confirmedSignature) banReasons.push("confirmed_signature")
  if (reputation.deniedUser) banReasons.push("denied_user")
  if (reputation.knownButtonDomain) banReasons.push("known_button_domain")
  if (reputation.knownViaBot) banReasons.push("known_via_bot")
  if (reputation.knownHandle) banReasons.push("known_handle")
  if (reputation.globalBurst) banReasons.push("global_burst")
  if (banReasons.length > 0) return { decision: "ban_all", reasons: banReasons }

  if (!signals.hasHan || !signals.hasMention) return { decision: "allow", reasons: [] }

  const supportingReasons: CampaignSpamReason[] = []
  if (reputation.freshUser) supportingReasons.push("fresh_user")
  if (signals.viaBotId !== undefined) supportingReasons.push("via_bot")
  if (signals.hasInlineKeyboard) supportingReasons.push("inline_keyboard")

  if (supportingReasons.length === 0) return { decision: "allow", reasons: [] }
  return { decision: "quarantine", reasons: ["han_with_mention", ...supportingReasons] }
}

/** Decides whether a join request should be declined or restricted and reviewed. */
export function classifyCampaignJoin(reputation: {
  deniedUser: boolean
  confirmedProfile: boolean
  profileAuthors: number
}): CampaignJoinClassification {
  if (reputation.deniedUser) return { decision: "decline", reviewReason: "denied_user" }
  if (reputation.confirmedProfile) return { decision: "decline", reviewReason: "confirmed_profile" }
  if (reputation.profileAuthors > 0) return { decision: "restrict", reviewReason: "partial_profile" }
  return { decision: "restrict" }
}
