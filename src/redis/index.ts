import { SocketClosedUnexpectedlyError, createClient } from "redis"

import { env } from "@/env"
import { logger } from "@/logger"

let openSuccess = false
const client = createClient({
  socket: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    reconnectStrategy: (retries) => {
      const n = retries + 1
      logger.debug(`[REDIS] reconnect retry #${n}`)
      if (openSuccess && n < 5) {
        const jitter = Math.floor(Math.random() * 200)
        const delay = Math.min(Math.pow(2, retries) * 50, 2000)
        return delay + jitter
      }

      if (n < 3) return 1000
      return false
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

export async function ready(): Promise<boolean> {
  if (client.isOpen) return true
  if (client.isReady) return true

  try {
    await client.connect()
    openSuccess = true
    return true
  } catch (_) {
    logger.error("[REDIS] connection failed. Some functions may not work correctly. This should be addressed ASAP.")
    return false
  }
}
void ready()

// type WithRedisCallback<T> = (props: { client: typeof client }) => Promise<T>
// export function withRedis<T>(callback: WithRedisCallback<T>): Promise<T | null> {
//   if (client.isReady) return callback({ client })
//   return new Promise((res) => {
//     res(null)
//   })
// }

export const redis = client
