import { createClient, SocketClosedUnexpectedlyError } from "redis"

import { env } from "@/env"
import { logger } from "@/logger"

const client = createClient({
  socket: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    reconnectStrategy: (retries) => {
      const n = retries + 1
      logger.debug(`[REDIS] reconnect retry #${n}`)
      // A storage outage must not permanently close the shared client. Keep
      // retrying so the bot and its in-memory adapters recover when Redis does.
      const jitter = Math.floor(Math.random() * 200)
      const delay = Math.min(2 ** retries * 50, 2000)
      return delay + jitter
    },
  },
  username: env.REDIS_USERNAME,
  password: env.REDIS_PASSWORD,
})

client.on("error", (err: object) => {
  if ("code" in err && err.code === "ECONNREFUSED") return
  else if (err instanceof SocketClosedUnexpectedlyError) logger.error("[REDIS] connection lost")
  else logger.error({ err }, "[REDIS] client error")
})
client.on("ready", () => {
  logger.info("[REDIS] client connected")
})
client.on("end", () => {
  logger.info("[REDIS] client disconnected")
})

async function ready(): Promise<boolean> {
  if (client.isOpen) return true
  if (client.isReady) return true

  try {
    await client.connect()
    return true
  } catch (_) {
    logger.error("[REDIS] connection failed. Some functions may not work correctly. This should be addressed ASAP.")
    return false
  }
}
void ready()

export const redis = client
