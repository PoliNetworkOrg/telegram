import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"

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
    LOG_LEVEL: z.string().default("DEBUG"),
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
