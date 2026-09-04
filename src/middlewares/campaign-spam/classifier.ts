import { nanohash } from "@/utils/crypto"

const HAN_PATTERN = /\p{Script=Han}/u
const MENTION_PATTERN = /@[\p{L}\p{N}_]{3,}/gu
const CONTROL_PATTERN = /\p{Cc}/gu
const FORMAT_PATTERN = /\p{Cf}/gu
const NUMBER_PATTERN = /\p{N}+/gu
const SPACE_PATTERN = /\s+/g

export type CampaignSpamDecision = "allow" | "quarantine" | "ban_all"

export type CampaignSpamReason =
  | "confirmed_signature"
  | "denied_user"
  | "fresh_user"
  | "global_burst"
  | "han_with_mention"
  | "inline_keyboard"
  | "known_button_domain"
  | "known_handle"
  | "known_via_bot"
  | "via_bot"

export type CampaignMessageInput = {
  text: string
  entityTypes?: readonly string[]
  buttonUrls?: readonly string[]
  hasInlineKeyboard?: boolean
  viaBotId?: number
}

export type CampaignMessageSignals = {
  normalizedText: string
  signatureHash: string
  hasHan: boolean
  hasMention: boolean
  mentionedHandleHashes: string[]
  buttonDomainHashes: string[]
  entityTypes: string[]
  hasInlineKeyboard: boolean
  viaBotId?: number
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

export function normalizeProfileName(firstName: string, lastName?: string): string {
  return `${firstName} ${lastName ?? ""}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(FORMAT_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(SPACE_PATTERN, " ")
    .trim()
}

export function campaignIndicatorHash(kind: "button" | "handle" | "profile" | "signature", value: string): string {
  return nanohash(`${kind}:${value}`, 24)
}

export function profileFingerprint(firstName: string, lastName?: string): string {
  return campaignIndicatorHash("profile", normalizeProfileName(firstName, lastName))
}

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, "").normalize("NFKC").toLowerCase()
}

export function handleFingerprint(handle: string): string {
  return campaignIndicatorHash("handle", normalizeHandle(handle))
}

function buttonDomain(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return parsed.hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return null
  }
}

export function buttonDomainFingerprint(domain: string): string {
  return campaignIndicatorHash("button", domain.toLowerCase().replace(/^www\./, ""))
}

export function extractCampaignSignals(input: CampaignMessageInput): CampaignMessageSignals {
  const normalizedText = normalizeCampaignText(input.text)
  const entityTypes = [...new Set(input.entityTypes ?? [])].sort()
  const mentionedHandles = [...input.text.matchAll(MENTION_PATTERN)].map(([handle]) => handle)
  const hasEntityMention = entityTypes.includes("mention") || entityTypes.includes("text_mention")
  const domains = (input.buttonUrls ?? []).map(buttonDomain).filter((domain) => domain !== null)

  return {
    normalizedText,
    signatureHash: campaignIndicatorHash("signature", normalizedText),
    hasHan: HAN_PATTERN.test(normalizedText),
    hasMention: hasEntityMention || mentionedHandles.length > 0,
    mentionedHandleHashes: [...new Set(mentionedHandles.map(handleFingerprint))],
    buttonDomainHashes: [...new Set(domains.map(buttonDomainFingerprint))],
    entityTypes,
    hasInlineKeyboard: input.hasInlineKeyboard ?? (input.buttonUrls?.length ?? 0) > 0,
    viaBotId: input.viaBotId,
  }
}

export function classifyCampaignMessage(
  signals: CampaignMessageSignals,
  reputation: CampaignReputationSnapshot
): CampaignClassification {
  const banReasons: CampaignSpamReason[] = []
  if (reputation.confirmedSignature) banReasons.push("confirmed_signature")
  if (reputation.deniedUser) banReasons.push("denied_user")
  if (reputation.knownButtonDomain) banReasons.push("known_button_domain")
  if (reputation.knownViaBot) banReasons.push("known_via_bot")
  if (reputation.globalBurst) banReasons.push("global_burst")
  if (banReasons.length > 0) return { decision: "ban_all", reasons: banReasons }

  if (!signals.hasHan || !signals.hasMention) return { decision: "allow", reasons: [] }

  if (reputation.knownHandle) {
    return { decision: "quarantine", reasons: ["han_with_mention", "known_handle"] }
  }

  const supportingReasons: CampaignSpamReason[] = []
  if (reputation.freshUser) supportingReasons.push("fresh_user")
  if (signals.viaBotId !== undefined) supportingReasons.push("via_bot")
  if (signals.hasInlineKeyboard) supportingReasons.push("inline_keyboard")

  if (supportingReasons.length === 0) return { decision: "allow", reasons: [] }
  return { decision: "quarantine", reasons: ["han_with_mention", ...supportingReasons] }
}
