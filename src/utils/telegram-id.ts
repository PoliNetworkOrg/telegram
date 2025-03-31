import { redis } from "@/redis"

export async function getTelegramId(username: string): Promise<number | null> {
  if (!redis.isReady) return null

  const res = await redis.get(`username:${username}:id`)
  if (!res) return null

  return parseInt(res)
}

export async function setTelegramId(
  username: string,
  id: number
): Promise<void> {
  if (redis.isReady) await redis?.set(`username:${username}:id`, id)
}
