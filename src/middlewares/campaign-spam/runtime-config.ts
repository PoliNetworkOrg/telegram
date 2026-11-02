import { env } from "@/env"
import { createCampaignSpamConfig } from "./config"

/** Feature invariants and reviewed indicators; protection is always active. */
export const campaignSpamConfig = createCampaignSpamConfig({
  fingerprintSecret: env.BOT_TOKEN,
  quarantineDuration: "10m",
  burstWindowSeconds: 600,
  burstAuthorThreshold: 3,
  burstChatThreshold: 2,
  slowFloodWindowSeconds: 14_400,
  slowFloodAuthorThreshold: 4,
  slowFloodChatThreshold: 2,
  freshWindowSeconds: 86_400,
  evidenceRetentionSeconds: 2_592_000,
  pendingMemberSeconds: 604_800,
  profileAuthorThreshold: 3,
  confirmedSignatures: [],
  deniedUserIds: [],
  deniedHandles: [],
  deniedButtonDomains: [],
  deniedViaBotIds: [],
})
