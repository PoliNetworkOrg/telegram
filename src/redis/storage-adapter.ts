import { logger } from "@/logger"
import { withRedis } from "@/redis"
import type { StorageAdapter } from "grammy"

export class RedisAdapter<T> implements StorageAdapter<T> {
  constructor(private prefix: string) {
    if (prefix.endsWith(":")) {
      prefix.slice(0, -1)
    }
  }

  private getKey(key: string): string {
    return `${this.prefix}:${key}`
  }

  async read(key: string): Promise<T | undefined> {
    const res = await withRedis(({ client }) => {
      return client.get(this.getKey(key))
    })

    if (res === null) return undefined
    try {
      return JSON.parse(res) as T
    } catch (err) {
      logger.error({ err }, "[STORAGE_ADAPTER] error while parsing read")
      return undefined
    }
  }

  async write(key: string, value: T): Promise<void> {
    await withRedis(({ client }) => {
      return client.set(this.getKey(key), JSON.stringify(value))
    })
  }

  async delete(key: string): Promise<void> {
    await withRedis(({ client }) => {
      return client.del(this.getKey(key))
    })
  }
}
