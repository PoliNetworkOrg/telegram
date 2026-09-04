import { describe, expect, it } from "vitest"
import { createCampaignFingerprintSecret } from "@/middlewares/campaign-spam/classifier"
import { openCampaignSpamReview, sealCampaignSpamReview } from "@/middlewares/campaign-spam/review-payload"
import { CAMPAIGN_TEST_SECRET } from "./fixtures/campaign-spam"

const review = {
  reviewId: "unique-review-id-123456789",
  createdAt: 1_788_340_000_000,
  source: "message" as const,
  target: { id: 987_654_321, is_bot: false, first_name: "Sensitive Target" },
  chat: { id: -100_987_654_321, type: "supergroup" as const, title: "Sensitive Group" },
  reasons: ["confirmed_signature" as const],
  signals: { signatureHash: "protected-signature" },
}

describe("campaign spam review payload", () => {
  it("encrypts sensitive callback state and restores it for authorized handling", () => {
    const payload = sealCampaignSpamReview(review, CAMPAIGN_TEST_SECRET)

    expect(payload).not.toContain(String(review.target.id))
    expect(payload).not.toContain(String(review.chat.id))
    expect(payload).not.toContain(review.target.first_name)
    expect(payload).not.toContain(review.signals.signatureHash)
    expect(openCampaignSpamReview(payload, CAMPAIGN_TEST_SECRET)).toEqual(review)
  })

  it("rejects payload tampering and the wrong deployment secret", () => {
    const payload = sealCampaignSpamReview(review, CAMPAIGN_TEST_SECRET)
    const [version, nonce, tag, ciphertext] = payload.split(".")
    if (!version || !nonce || !tag || !ciphertext) throw new Error("expected sealed review payload")
    const tamperedTag = `${tag.startsWith("A") ? "B" : "A"}${tag.slice(1)}`
    const tampered = [version, nonce, tamperedTag, ciphertext].join(".")

    expect(() => openCampaignSpamReview(tampered, CAMPAIGN_TEST_SECRET)).toThrow()
    expect(() =>
      openCampaignSpamReview(payload, createCampaignFingerprintSecret(`${CAMPAIGN_TEST_SECRET}-other`))
    ).toThrow()
  })

  it("rejects an authenticated payload whose review shape is invalid", () => {
    const invalidReview = { ...review, target: { ...review.target, id: "not-a-user-id" } }
    const payload = sealCampaignSpamReview(invalidReview as never, CAMPAIGN_TEST_SECRET)

    expect(() => openCampaignSpamReview(payload, CAMPAIGN_TEST_SECRET)).toThrow()
  })
})
