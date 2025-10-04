import pino from "pino"

export const logger = pino({
  // the reason why we use process.env instead of @/env is that
  // we want the logger to be working also in tests where we do not have
  // environment variables set. If we used @/env it would throw an error
  level: process.env.LOG_LEVEL || "debug",
})
