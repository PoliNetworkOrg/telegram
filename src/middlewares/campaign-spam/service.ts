import { redis } from "@/redis"
import { type CampaignRedis, CampaignReputation } from "./reputation"
import { campaignSpamConfig } from "./runtime-config"

export const campaignSpamReputation = new CampaignReputation(redis as CampaignRedis, campaignSpamConfig)
