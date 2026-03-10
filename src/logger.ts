import { createEnv } from "@t3-oss/env-core"
import pino from "pino"
import { z } from "zod/v4"

const loggerEnv = createEnv({
  server: {
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("debug"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})

export const logger = pino({
  // Keep logger bootstrap independent from the main app env module:
  // tests may import the logger without having the full runtime env set.
  level: loggerEnv.LOG_LEVEL,
})
