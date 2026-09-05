import {
  buttonDomainFingerprint,
  buttonUrlFingerprint,
  type CampaignMessageInput,
  campaignIndicatorHash,
  createCampaignFingerprintSecret,
  extractCampaignSignals,
  handleFingerprint,
  profileFingerprint,
} from "@/middlewares/campaign-spam/classifier"

export const CAMPAIGN_TEST_SECRET = createCampaignFingerprintSecret("test-campaign-fingerprint-secret-32-bytes")

/** Binds the shared test secret to campaign fingerprint operations. */
export const campaignTestFingerprint = {
  indicatorHash: (kind: Parameters<typeof campaignIndicatorHash>[0], value: string) =>
    campaignIndicatorHash(kind, value, CAMPAIGN_TEST_SECRET),
  extractSignals: (input: CampaignMessageInput) => extractCampaignSignals(input, CAMPAIGN_TEST_SECRET),
  handle: (value: string) => handleFingerprint(value, CAMPAIGN_TEST_SECRET),
  buttonUrl: (value: string) => buttonUrlFingerprint(value, CAMPAIGN_TEST_SECRET),
  buttonDomain: (value: string) => buttonDomainFingerprint(value, CAMPAIGN_TEST_SECRET),
  profile: (firstName: string, lastName?: string) => profileFingerprint(firstName, lastName, CAMPAIGN_TEST_SECRET),
}
