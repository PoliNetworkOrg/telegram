import { env } from "@/env"
import { createCampaignSpamConfig } from "./config"

export const campaignSpamConfig = createCampaignSpamConfig({
  mode: env.CAMPAIGN_SPAM_MODE,
  joinGate: env.CAMPAIGN_SPAM_JOIN_GATE,
  quarantineDuration: env.CAMPAIGN_SPAM_QUARANTINE_DURATION,
  burstWindowSeconds: env.CAMPAIGN_SPAM_BURST_WINDOW_SECONDS,
  burstAuthorThreshold: env.CAMPAIGN_SPAM_BURST_AUTHOR_THRESHOLD,
  burstChatThreshold: env.CAMPAIGN_SPAM_BURST_CHAT_THRESHOLD,
  freshWindowSeconds: env.CAMPAIGN_SPAM_FRESH_WINDOW_SECONDS,
  evidenceRetentionSeconds: env.CAMPAIGN_SPAM_EVIDENCE_RETENTION_SECONDS,
  pendingMemberSeconds: env.CAMPAIGN_SPAM_PENDING_MEMBER_SECONDS,
  profileAuthorThreshold: env.CAMPAIGN_SPAM_PROFILE_AUTHOR_THRESHOLD,
  confirmedSignaturesJson: env.CAMPAIGN_SPAM_CONFIRMED_SIGNATURES_JSON,
  deniedUserIdsJson: env.CAMPAIGN_SPAM_DENIED_USER_IDS_JSON,
  deniedHandlesJson: env.CAMPAIGN_SPAM_DENIED_HANDLES_JSON,
  deniedButtonDomainsJson: env.CAMPAIGN_SPAM_DENIED_BUTTON_DOMAINS_JSON,
  deniedViaBotIdsJson: env.CAMPAIGN_SPAM_DENIED_VIA_BOT_IDS_JSON,
})
