import { createEnv } from "@t3-oss/env-core"
import { z } from "zod/v4"
import {
  isTemporaryTelegramRestrictionDuration,
  TELEGRAM_MAX_TEMPORARY_RESTRICTION_SECONDS,
} from "@/utils/telegram-restriction"

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true")

// coerce is needed for non-string values, because k8s supports only string env
export const env = createEnv({
  server: {
    BOT_TOKEN: z.string(),
    BACKEND_URL: z.string(),
    REDIS_HOST: z.string().min(1).optional(),
    REDIS_PORT: z.coerce.number().min(1).max(65535).default(6379),
    REDIS_USERNAME: z.string().min(1).optional(),
    REDIS_PASSWORD: z.string().min(1).optional(),
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    OPENAI_API_KEY: z.string().optional(),
    INFLUXDB_TOKEN: z.string().optional(),
    INFLUXDB_URL: z.string().default("http://localhost:8086"),
    CAMPAIGN_SPAM_MODE: z.enum(["off", "observe", "quarantine", "enforce"]).default("off"),
    CAMPAIGN_SPAM_JOIN_GATE: booleanString,
    CAMPAIGN_SPAM_QUARANTINE_DURATION: z
      .string()
      .refine(isTemporaryTelegramRestrictionDuration, "must be a temporary Telegram restriction duration")
      .default("10m"),
    CAMPAIGN_SPAM_BURST_WINDOW_SECONDS: z.coerce.number().int().min(60).default(600),
    CAMPAIGN_SPAM_BURST_AUTHOR_THRESHOLD: z.coerce.number().int().min(2).default(3),
    CAMPAIGN_SPAM_BURST_CHAT_THRESHOLD: z.coerce.number().int().min(2).default(2),
    CAMPAIGN_SPAM_SLOW_FLOOD_WINDOW_SECONDS: z.coerce.number().int().min(600).default(14_400),
    CAMPAIGN_SPAM_SLOW_FLOOD_AUTHOR_THRESHOLD: z.coerce.number().int().min(3).default(4),
    CAMPAIGN_SPAM_SLOW_FLOOD_CHAT_THRESHOLD: z.coerce.number().int().min(2).default(2),
    CAMPAIGN_SPAM_FRESH_WINDOW_SECONDS: z.coerce.number().int().min(60).default(86_400),
    CAMPAIGN_SPAM_EVIDENCE_RETENTION_SECONDS: z.coerce.number().int().min(3600).default(2_592_000),
    CAMPAIGN_SPAM_PENDING_MEMBER_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(TELEGRAM_MAX_TEMPORARY_RESTRICTION_SECONDS)
      .default(604_800),
    CAMPAIGN_SPAM_PROFILE_AUTHOR_THRESHOLD: z.coerce.number().int().min(2).default(3),
    CAMPAIGN_SPAM_CONFIRMED_SIGNATURES_JSON: z.string().default("[]"),
    CAMPAIGN_SPAM_DENIED_USER_IDS_JSON: z.string().default("[]"),
    CAMPAIGN_SPAM_DENIED_HANDLES_JSON: z.string().default("[]"),
    CAMPAIGN_SPAM_DENIED_BUTTON_DOMAINS_JSON: z.string().default("[]"),
    CAMPAIGN_SPAM_DENIED_VIA_BOT_IDS_JSON: z.string().default("[]"),
    CAMPAIGN_SPAM_FINGERPRINT_SECRET: z.string().min(32).optional(),
  },

  runtimeEnv: process.env,
  /**
   * By default, this library will feed the environment variables directly to
   * the Zod validator.
   *
   * This means that if you have an empty string for a value that is supposed
   * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
   * it as a type mismatch violation. Additionally, if you have an empty string
   * for a value that is supposed to be a string with a default value (e.g.
   * `DOMAIN=` in an ".env" file), the default value will never be applied.
   *
   * In order to solve these issues, we recommend that all new projects
   * explicitly specify this option as true.
   */
  emptyStringAsUndefined: true,
})
