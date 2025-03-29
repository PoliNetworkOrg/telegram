import { createClient, type RedisClientType } from "redis"
import "dotenv/config"

const client: RedisClientType = createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT!),
  },
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
})

await client.connect()

export async function getTelegramId(username: string): Promise<number | null> {
  const res = await client.get(`username:${username}:id`)
  if (!res) return null

  return parseInt(res)
}

export async function setTelegramId(
  username: string,
  id: number
): Promise<void> {
  await client.set(`username:${username}:id`, id)
}

export { client as redis }
