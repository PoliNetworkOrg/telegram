import redis from 'redis'

export const PREFIX = "tsbot"
export const key = (key: string) => `${PREFIX}:${key}`

export const client = await redis
  .createClient({
    socket: {
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT!),
    },
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
  })
  .connect()

export async function getTelegramId(username: string): Promise<number | null> {
  const res = await client.get(key(`username:${username}:id`))
  if (!res) return null

  return parseInt(res)
}

export async function setTelegramId(username: string, id: number): Promise<void> {
  await client.set(key(`username:${username}:id`), id)
}
