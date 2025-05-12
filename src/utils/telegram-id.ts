import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { redis } from "@/redis"

const usernameRedis = new RedisFallbackAdapter<number>({
  redis,
  prefix: "username",
})

export async function getTelegramId(username: string): Promise<number | null> {
  const key = `${username.replaceAll("@", "")}:id`
  return (await usernameRedis.read(key)) ?? null
}

export async function setTelegramId(username: string, id: number) {
  const key = `${username}:id`
  await usernameRedis.write(key, id)
}
