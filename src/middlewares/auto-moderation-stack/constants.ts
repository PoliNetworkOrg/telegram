import type { Category } from "./types"

export const POLINETWORK_DISCORD_GUILD_ID = "1286773946045300787"
export const BANNED_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "bit.ly",
  "is.gd",
  "amzn.to",
  "goo.gl",
  "forms.gle",
  "docs.google.com",
  "amazon.it/gp/student",
  "amazon.com/gp/student",
  "polinetwork.it",
] as const

export const DELETION_THRESHOLDS: Record<Category, number | false> = {
  harassment: false,
  "harassment/threatening": 0.9,
  hate: 0.9,
  "hate/threatening": 0.9,
  illicit: false,
  "illicit/violent": false,
  violence: 0.1,
  "violence/graphic": false,
  sexual: 0.9,
  "sexual/minors": 0.8,
  "self-harm": false,
  "self-harm/intent": false,
  "self-harm/instructions": false,
} as const

export const MULTI_CHAT_SPAM = {
  SIMILARITY_THR: 87,
  LENGTH_THR: 128,
  EXPIRY: 60, // seconds
  MUTE_DURATION: "5m",
} as const

export const NON_LATIN = {
  LENGTH_THR: 8,
  PERCENTAGE_THR: 0.2,
  MUTE_DURATION: "10m",
  /**
   * Regex to match non-latin characters, greek is allowed as well.
   * matches any character that is not:
   * - Latin extended script
   * - Undetermined script (common script) (for some reason µ is here, maths ig)
   * - Greek script (just because engineering, catching stray π and Ω characters)
   * - Decimal numbers in any script
   * - Punctuation
   * - Symbols, math, currency, emojis, etc.
   * - Spaces and separators
   * - Control characters
   *
   * I really hope this covers everything we want to allow. - tm
   */
  REGEX: /[^\p{scx=Latin}\p{sc=Zyyy}\p{sc=Greek}\p{Nd}\p{P}\p{S}\p{Z}\p{C}]/gu,
} as const
