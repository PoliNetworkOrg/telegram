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
