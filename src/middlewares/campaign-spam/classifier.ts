import { keyedHash } from "@/utils/crypto"

const HAN_PATTERN = /\p{Script=Han}/u
const MENTION_PATTERN = /@[\p{L}\p{N}_]{3,}/gu
const CONTROL_PATTERN = /\p{Cc}/gu
const FORMAT_PATTERN = /\p{Cf}/gu
const CHINESE_NUMERALS = "零〇一壹二贰貳两兩三叁參四肆五伍六陆陸七柒八捌九玖十拾百佰栢千仟万萬亿億"
const NUMERIC_SPAN_PATTERN = new RegExp(`[\\p{N}${CHINESE_NUMERALS}o]+`, "gu")
const NUMERIC_COMPONENT_PATTERN = new RegExp(`[\\p{N}${CHINESE_NUMERALS}]`, "u")
const NUMERIC_COMPONENTS_PATTERN = new RegExp(`[\\p{N}${CHINESE_NUMERALS}]+`, "gu")
const ASCII_LETTER_PATTERN = /[a-z]/u
const SPACE_PATTERN = /\s+/g
const CAMPAIGN_LURE_PATTERN =
  /(?:收米|上车吃肉|日入|洗资|聘群演|招群演|开房同住|查人查档|天眼查|网逃案件|#分钟#单|注册(?:即)?送|小额收|招兼职|招日结)/u
const CURRENCY_MARKER_PATTERN = /[🧧💰💵💸🤑]/u
const NUMERIC_OFFER_PATTERN = /#\s*(?:\+|[ku])/u

export const CAMPAIGN_SPAM_MODEL_VERSION = "deterministic-v2"
export const CAMPAIGN_SPAM_FINGERPRINT_VERSION = "hmac-v2"

declare const campaignFingerprintSecretBrand: unique symbol
export type CampaignFingerprintSecret = string & { readonly [campaignFingerprintSecretBrand]: true }

/** Validates and brands a secret before campaign cryptographic operations can use it. */
export function createCampaignFingerprintSecret(value: string): CampaignFingerprintSecret {
  if (value.length < 32) throw new TypeError("campaign fingerprint secret must contain at least 32 characters")
  return value as CampaignFingerprintSecret
}

export type CampaignSpamDecision = "allow" | "quarantine" | "ban_all"

export const CAMPAIGN_SPAM_REASONS = [
  "confirmed_signature",
  "confirmed_profile",
  "contact_card",
  "denied_user",
  "external_link",
  "first_post",
  "fresh_user",
  "global_burst",
  "campaign_lure",
  "han_with_mention",
  "inline_keyboard",
  "known_button_domain",
  "known_handle",
  "known_via_bot",
  "partial_profile",
  "risky_profile",
  "slow_flood",
  "via_bot",
] as const

export type CampaignSpamReason = (typeof CAMPAIGN_SPAM_REASONS)[number]

export type CampaignJoinClassification = {
  decision: "decline" | "restrict"
  reviewReason?: Extract<CampaignSpamReason, "confirmed_profile" | "denied_user" | "partial_profile" | "risky_profile">
}

export type CampaignMessageInput = {
  text: string
  source?: "text" | "caption" | "contact"
  contactPhoneNumber?: string
  entityTypes?: readonly string[]
  mentionedUserIds?: readonly number[]
  linkUrls?: readonly string[]
  buttonUrls?: readonly string[]
  hasInlineKeyboard?: boolean
  viaBotId?: number
  viaBotUsername?: string
}

export type CampaignMessageSignals = {
  source: "text" | "caption" | "contact"
  normalizedText: string
  signatureHash: string
  hasHan: boolean
  hasMention: boolean
  hasCampaignLure: boolean
  hasContactCard: boolean
  hasLink: boolean
  mentionedHandleHashes: string[]
  mentionedUserIdHashes: string[]
  buttonUrlHashes: string[]
  buttonDomainHashes: string[]
  contactPhoneHash?: string
  entityTypes: string[]
  hasInlineKeyboard: boolean
  viaBotIdHash?: string
  viaBotUsernameHash?: string
}

export type CampaignReputationSnapshot = {
  confirmedSignature: boolean
  deniedUser: boolean
  freshUser: boolean
  globalBurst: boolean
  slowFlood: boolean
  knownButtonDomain: boolean
  knownHandle: boolean
  knownViaBot: boolean
  distinctAuthors: number
  distinctChats: number
  slowDistinctAuthors: number
  slowDistinctChats: number
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
  slowFlood: false,
  knownButtonDomain: false,
  knownHandle: false,
  knownViaBot: false,
  distinctAuthors: 0,
  distinctChats: 0,
  slowDistinctAuthors: 0,
  slowDistinctChats: 0,
}

function normalizeNumericSpans(text: string): string {
  return text.replace(NUMERIC_SPAN_PATTERN, (span, offset: number, source: string) => {
    if (!NUMERIC_COMPONENT_PATTERN.test(span)) return span
    const touchesAsciiWord =
      ASCII_LETTER_PATTERN.test(source[offset - 1] ?? "") ||
      ASCII_LETTER_PATTERN.test(source[offset + span.length] ?? "")
    if (span.includes("o") && touchesAsciiWord) return span.replace(NUMERIC_COMPONENTS_PATTERN, "#")
    return "#"
  })
}

/** Redacts rotating handles, Chinese numeral spans, and numeric homoglyphs for stable signatures. */
export function normalizeCampaignText(text: string): string {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(FORMAT_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(MENTION_PATTERN, "<mention>")

  return normalizeNumericSpans(normalized).replace(SPACE_PATTERN, " ").trim()
}

/** Detects high-precision recruitment, fraud, gambling, and query-service phrases. */
export function hasCampaignLure(text: string): boolean {
  return CAMPAIGN_LURE_PATTERN.test(normalizeCampaignText(text))
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

/** Creates a versioned, keyed HMAC-SHA-256 fingerprint without retaining the source value. */
export function campaignIndicatorHash(
  kind:
    | "button_domain"
    | "button_url"
    | "chat_id"
    | "contact_phone"
    | "handle"
    | "mention_user"
    | "profile"
    | "review_id"
    | "signature"
    | "user_id"
    | "via_bot",
  value: string,
  fingerprintSecret: CampaignFingerprintSecret
): string {
  return keyedHash(`${CAMPAIGN_SPAM_FINGERPRINT_VERSION}:${kind}:${value}`, fingerprintSecret)
}

/** Returns the stable hash used for exact display-name reputation. */
export function profileFingerprint(
  firstName: string,
  lastName: string | undefined,
  fingerprintSecret: CampaignFingerprintSecret
): string {
  return campaignIndicatorHash("profile", normalizeProfileName(firstName, lastName), fingerprintSecret)
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").normalize("NFKC").toLowerCase()
}

/** Returns the stable hash used for case-insensitive Telegram handles. */
export function handleFingerprint(handle: string, fingerprintSecret: CampaignFingerprintSecret): string {
  return campaignIndicatorHash("handle", normalizeHandle(handle), fingerprintSecret)
}

function normalizedButtonUrl(url: string): string | null {
  try {
    const trimmed = url.trim()
    return new URL(/^(?:www\.)?(?:t\.me|telegram\.me)\//i.test(trimmed) ? `https://${trimmed}` : trimmed).toString()
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

function linkedTelegramHandle(url: string): string | null {
  const normalizedUrl = normalizedButtonUrl(url)
  if (!normalizedUrl) return null
  const parsed = new URL(normalizedUrl)
  if (parsed.protocol === "tg:" && parsed.hostname === "resolve") {
    const candidate = parsed.searchParams.get("domain")
    return candidate && /^[a-z][a-z0-9_]{2,}$/i.test(candidate) ? candidate : null
  }
  const hostname = parsed.hostname.replace(/^www\./, "")
  if (hostname !== "t.me" && hostname !== "telegram.me") return null
  const segments = parsed.pathname.split("/").filter(Boolean)
  const candidate = segments[0] === "s" ? segments[1] : segments[0]
  if (!candidate || candidate.startsWith("+") || ["c", "joinchat", "s", "share"].includes(candidate)) return null
  return /^[a-z][a-z0-9_]{2,}$/i.test(candidate) ? candidate : null
}

/** Hashes a normalized full button URL, including its path and query. */
export function buttonUrlFingerprint(url: string, fingerprintSecret: CampaignFingerprintSecret): string {
  return campaignIndicatorHash(
    "button_url",
    normalizedButtonUrl(url) ?? url.trim().normalize("NFKC"),
    fingerprintSecret
  )
}

/** Hashes a normalized hostname for domain-level button matching. */
export function buttonDomainFingerprint(domain: string, fingerprintSecret: CampaignFingerprintSecret): string {
  const trimmed = domain.trim()
  const normalizedDomain = buttonDomain(trimmed.includes("://") ? trimmed : `https://${trimmed}`) ?? trimmed
  return campaignIndicatorHash("button_domain", normalizedDomain.toLowerCase().replace(/^www\./, ""), fingerprintSecret)
}

/** Converts message text and Telegram metadata into privacy-preserving classifier signals. */
export function extractCampaignSignals(
  input: CampaignMessageInput,
  fingerprintSecret: CampaignFingerprintSecret
): CampaignMessageSignals {
  const normalizedText = normalizeCampaignText(input.text)
  const entityTypes = [...new Set(input.entityTypes ?? [])].sort()
  const mentionedHandles = [...input.text.matchAll(MENTION_PATTERN)].map(([handle]) => handle)
  const hasEntityMention = entityTypes.includes("mention") || entityTypes.includes("text_mention")
  const mentionedUserIds = [...new Set(input.mentionedUserIds ?? [])]
  const allUrls = [...(input.linkUrls ?? []), ...(input.buttonUrls ?? [])]
  const normalizedUrls = allUrls.map(normalizedButtonUrl).filter((url) => url !== null)
  const domains = allUrls.map(buttonDomain).filter((domain) => domain !== null)
  const linkedHandles = allUrls.map(linkedTelegramHandle).filter((handle) => handle !== null)

  return {
    source: input.source ?? "text",
    normalizedText,
    signatureHash: campaignIndicatorHash("signature", normalizedText, fingerprintSecret),
    hasHan: HAN_PATTERN.test(normalizedText),
    hasMention: hasEntityMention || mentionedHandles.length > 0,
    hasCampaignLure: CAMPAIGN_LURE_PATTERN.test(normalizedText),
    hasContactCard: input.source === "contact",
    hasLink: normalizedUrls.length > 0 || entityTypes.includes("url") || entityTypes.includes("text_link"),
    mentionedHandleHashes: [
      ...new Set([...mentionedHandles, ...linkedHandles].map((handle) => handleFingerprint(handle, fingerprintSecret))),
    ],
    mentionedUserIdHashes: mentionedUserIds.map((userId) =>
      campaignIndicatorHash("mention_user", String(userId), fingerprintSecret)
    ),
    buttonUrlHashes: [...new Set(normalizedUrls.map((url) => buttonUrlFingerprint(url, fingerprintSecret)))],
    buttonDomainHashes: [...new Set(domains.map((domain) => buttonDomainFingerprint(domain, fingerprintSecret)))],
    entityTypes,
    hasInlineKeyboard: input.hasInlineKeyboard ?? (input.buttonUrls?.length ?? 0) > 0,
    contactPhoneHash: input.contactPhoneNumber
      ? campaignIndicatorHash("contact_phone", input.contactPhoneNumber, fingerprintSecret)
      : undefined,
    viaBotIdHash:
      input.viaBotId === undefined
        ? undefined
        : campaignIndicatorHash("via_bot", String(input.viaBotId), fingerprintSecret),
    viaBotUsernameHash: input.viaBotUsername ? handleFingerprint(input.viaBotUsername, fingerprintSecret) : undefined,
  }
}

/** Limits dynamic observation to messages with both Han text and a campaign-shaped transport or phrase. */
export function isCampaignCandidate(signals: CampaignMessageSignals): boolean {
  return (
    signals.hasHan &&
    (signals.hasMention ||
      signals.hasCampaignLure ||
      signals.hasContactCard ||
      signals.hasLink ||
      signals.hasInlineKeyboard ||
      signals.viaBotIdHash !== undefined)
  )
}

/** Flags profiles for review only when several current campaign markers appear together. */
export function isRiskyCampaignProfile(firstName: string, lastName?: string, username?: string): boolean {
  if (username) return false
  const normalized = normalizeCampaignText(`${firstName} ${lastName ?? ""}`)
  return (
    HAN_PATTERN.test(normalized) &&
    (CAMPAIGN_LURE_PATTERN.test(normalized) ||
      CURRENCY_MARKER_PATTERN.test(normalized) ||
      NUMERIC_OFFER_PATTERN.test(normalized))
  )
}

/** Applies the auditable allow, quarantine, and BanAll decision rules. */
export function classifyCampaignMessage(
  signals: CampaignMessageSignals,
  reputation: CampaignReputationSnapshot,
  context: { firstPost?: boolean } = {}
): CampaignClassification {
  const banReasons: CampaignSpamReason[] = []
  if (reputation.confirmedSignature) banReasons.push("confirmed_signature")
  if (reputation.deniedUser) banReasons.push("denied_user")
  if (reputation.knownViaBot) banReasons.push("known_via_bot")
  if (reputation.globalBurst) banReasons.push("global_burst")
  if (reputation.slowFlood) banReasons.push("slow_flood")
  if (banReasons.length > 0) return { decision: "ban_all", reasons: banReasons }

  if (!isCampaignCandidate(signals)) return { decision: "allow", reasons: [] }

  const campaignReasons: CampaignSpamReason[] = []
  if (signals.hasMention) campaignReasons.push("han_with_mention")
  if (signals.hasCampaignLure) campaignReasons.push("campaign_lure")
  if (signals.hasContactCard) campaignReasons.push("contact_card")
  if (signals.hasLink) campaignReasons.push("external_link")
  if (reputation.knownButtonDomain) campaignReasons.push("known_button_domain")
  if (reputation.knownHandle) campaignReasons.push("known_handle")

  const supportingReasons: CampaignSpamReason[] = []
  if (context.firstPost) supportingReasons.push("first_post")
  if (reputation.freshUser) supportingReasons.push("fresh_user")
  if (signals.viaBotIdHash !== undefined) supportingReasons.push("via_bot")
  if (signals.hasInlineKeyboard) supportingReasons.push("inline_keyboard")

  if (!signals.hasCampaignLure && supportingReasons.length === 0) return { decision: "allow", reasons: [] }
  return { decision: "quarantine", reasons: [...campaignReasons, ...supportingReasons] }
}

/** Decides whether a join request should be declined or restricted and reviewed. */
export function classifyCampaignJoin(reputation: {
  deniedUser: boolean
  confirmedProfile: boolean
  profileAuthors: number
  riskyProfile?: boolean
}): CampaignJoinClassification {
  if (reputation.deniedUser) return { decision: "decline", reviewReason: "denied_user" }
  if (reputation.confirmedProfile) return { decision: "decline", reviewReason: "confirmed_profile" }
  if (reputation.riskyProfile) return { decision: "restrict", reviewReason: "risky_profile" }
  if (reputation.profileAuthors > 0) return { decision: "restrict", reviewReason: "partial_profile" }
  return { decision: "restrict" }
}
