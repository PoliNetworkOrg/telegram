import { withRedis } from "@/redis"

export async function getTelegramId(username: string): Promise<number | null> {
  const res = await withRedis(({ client }) => client.get(`username:${username.replaceAll("@", "")}:id`))
  if (!res) return null

  return parseInt(res)
}

export const setTelegramId = (username: string, id: number) =>
  withRedis(({ client }) => client.set(`username:${username}:id`, id))
