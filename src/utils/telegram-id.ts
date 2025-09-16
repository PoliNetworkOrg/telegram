import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { redis } from "@/redis"

const usernameRedis = new RedisFallbackAdapter<number>({
  redis,
  prefix: "username",
  logger,
})

export async function getTelegramId(username: string): Promise<number | null> {
  const key = `${username.toLowerCase().replaceAll("@", "")}:id`
  return (await usernameRedis.read(key)) ?? null
}

export async function setTelegramId(username: string, id: number) {
  const key = `${username.toLowerCase()}:id`
  await usernameRedis.write(key, id)
}
