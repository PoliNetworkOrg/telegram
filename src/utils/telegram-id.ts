import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { redis } from "@/redis"
import { BotAttributes, withSpan } from "@/telemetry"

const usernameRedis = new RedisFallbackAdapter<number>({
  redis,
  prefix: "username",
  logger,
})

export async function getTelegramId(username: string): Promise<number | null> {
  const key = `${username.toLowerCase().replaceAll("@", "")}:id`
  return await withSpan(
    "bot.cache.username_get",
    {
      [BotAttributes.IMPORTANCE]: "low",
      [BotAttributes.CACHE_OPERATION]: "username_get",
      [BotAttributes.USERNAME]: username,
    },
    async () => (await usernameRedis.read(key)) ?? null
  )
}

export async function setTelegramId(username: string, id: number) {
  const key = `${username.toLowerCase()}:id`
  await withSpan(
    "bot.cache.username_set",
    {
      [BotAttributes.IMPORTANCE]: "low",
      [BotAttributes.CACHE_OPERATION]: "username_set",
      [BotAttributes.USERNAME]: username,
      [BotAttributes.USER_ID]: id,
    },
    async () => {
      await usernameRedis.write(key, id)
    }
  )
}
