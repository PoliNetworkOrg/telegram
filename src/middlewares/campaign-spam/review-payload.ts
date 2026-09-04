import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"
import { z } from "zod/v4"
import { CAMPAIGN_SPAM_REASONS, type CampaignFingerprintSecret } from "./classifier"

const REVIEW_PAYLOAD_VERSION = "v2"
const REVIEW_KEY_CONTEXT = "campaign-spam-review:v2"

const reviewUserSchema = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean(),
  first_name: z.string().min(1),
  last_name: z.string().optional(),
  username: z.string().optional(),
})

const titledChatFields = {
  id: z.number().int(),
  title: z.string().min(1),
}
const reviewChatSchema = z.discriminatedUnion("type", [
  z.object({ ...titledChatFields, type: z.literal("group") }),
  z.object({ ...titledChatFields, type: z.literal("supergroup"), username: z.string().optional() }),
  z.object({ ...titledChatFields, type: z.literal("channel"), username: z.string().optional() }),
])

const campaignSpamReviewSchema = z.object({
  reviewId: z.string().min(16).max(128),
  createdAt: z.number().int().nonnegative(),
  source: z.enum(["join_request", "member_join", "message"]),
  target: reviewUserSchema,
  chat: reviewChatSchema,
  reasons: z.array(z.enum(CAMPAIGN_SPAM_REASONS)).min(1),
  signals: z.object({ signatureHash: z.string().min(1) }).optional(),
})

export type CampaignSpamReview = z.infer<typeof campaignSpamReviewSchema>
export type CampaignSpamReviewDraft = Omit<CampaignSpamReview, "createdAt" | "reviewId">

/** Adds unique, time-ordered state used to make moderator decisions single-use and stale-safe. */
export function createCampaignSpamReview(review: CampaignSpamReviewDraft): CampaignSpamReview {
  return {
    ...review,
    reviewId: randomBytes(16).toString("base64url"),
    createdAt: Date.now(),
  }
}

/** Derives a purpose-specific encryption key without reusing the HMAC output space. */
function reviewEncryptionKey(fingerprintSecret: CampaignFingerprintSecret): Buffer {
  return createHmac("sha256", fingerprintSecret).update(REVIEW_KEY_CONTEXT).digest()
}

/** Encrypts sensitive review state before the menu adapter persists it in Redis. */
export function sealCampaignSpamReview(
  review: CampaignSpamReview,
  fingerprintSecret: CampaignFingerprintSecret
): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", reviewEncryptionKey(fingerprintSecret), nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(review), "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    REVIEW_PAYLOAD_VERSION,
    nonce.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".")
}

/** Authenticates and decrypts campaign review state after callback authorization. */
export function openCampaignSpamReview(
  payload: string,
  fingerprintSecret: CampaignFingerprintSecret
): CampaignSpamReview {
  const [version, nonce, tag, ciphertext, ...extra] = payload.split(".")
  if (version !== REVIEW_PAYLOAD_VERSION || !nonce || !tag || !ciphertext || extra.length > 0) {
    throw new TypeError("Invalid campaign review payload")
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    reviewEncryptionKey(fingerprintSecret),
    Buffer.from(nonce, "base64url")
  )
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
    "utf8"
  )
  return campaignSpamReviewSchema.parse(JSON.parse(plaintext))
}
