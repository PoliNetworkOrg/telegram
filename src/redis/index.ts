import { createClient, SocketClosedUnexpectedlyError } from "redis"
import { logger } from "@/logger"
import { RedisAdapter } from "@grammyjs/storage-redis"
import { ConversationData, VersionedState } from "@grammyjs/conversations"

let openSuccess = false
const client = createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT!),
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
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
})

client.on("error", (err) => {
  if (err.code === "ECONNREFUSED") return
  else if (err instanceof SocketClosedUnexpectedlyError)
    logger.error("[REDIS] connection lost")
  else logger.error({ err }, "[REDIS] client error")
})
client.on("ready", () => logger.info("[REDIS] client connected"))
client.on("end", () => logger.info("[REDIS] client disconnected"))

try {
  await client.connect()
  openSuccess = true
} catch (_) {
  logger.error(
    "[REDIS] connection failed. Some functions may not work correctly. This should be addressed ASAP."
  )
}

type Function<T> = (props: { client: typeof client }) => Promise<T>
export type WithStorage<T> = (callback: Function<T>) => Promise<T | null>

export function withRedis<T>(callback: Function<T>): Promise<T | null> {
  if (client.isReady) return callback({ client })
  return new Promise((res) => res(null))
}

export const redis = client
export const conversationAdapter = new RedisAdapter<VersionedState<ConversationData>>({ instance: client, ttl: 10, autoParseDates: true });

