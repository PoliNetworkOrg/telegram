import { EventEmitter } from "node:events"
import {
  createClient,
  type RedisClientOptions,
  type RedisClientType,
  type RedisFunctions,
  type RedisModules,
  type RedisScripts,
} from "redis"

export interface RedisSetOptions<M extends RedisModules, F extends RedisFunctions, S extends RedisScripts> {
  /** Redis client instance, or options to create one */
  redis: RedisClientType<M, F, S> | RedisClientOptions<M, F, S>
  /** Time to live for each entry in seconds, uses redis' EXPIRE command */
  ttl?: number
  /**
   * Prefix for each key stored in redis, to avoid collisions, if not provided a
   * default one will be used to ensure uniqueness across multiple instances
   */
  prefix?: string
}

export class RedisSet<
  M extends RedisModules = RedisModules,
  F extends RedisFunctions = RedisFunctions,
  S extends RedisScripts = RedisScripts,
> {
  private static instanceCount = 0
  private prefix: string
  // In-memory cache used when Redis is not available
  private memoryCache: Set<string> = new Set()
  // temporary store for keys that need to be deleted once redis is back (used when delete does not find the key in memoryCache)
  private deletions: Set<string> = new Set()
  private redisClient: RedisClientType<M, F, S>

  constructor(private options: RedisSetOptions<M, F, S>) {
    const prefix = options.prefix ?? `redis-set-${RedisSet.instanceCount++}`
    if (prefix.endsWith(":")) {
      prefix.slice(0, -1)
    }
    this.prefix = prefix
    if (options.redis instanceof EventEmitter) {
      // RedisClient extends event emitter :)
      this.redisClient = options.redis
    } else {
      this.redisClient = createClient(options.redis)
      void this.redisClient.connect()
    }

    this.redisClient.on("ready", () => {
      void this.flushMemoryCache()
    })
  }

  /**
   * Flush the in-memory cache to Redis. Called automatically when the Redis
   * connection is re-established.
   */
  private async flushMemoryCache() {
    // write all memoryCache entries to redis
    await Promise.all(this.memoryCache.values().map((value) => this._add(value)))
    this.memoryCache.clear()
    // delete all keys that were marked for deletion while redis was down
    await Promise.all(this.deletions.values().map((k) => this._delete(k)))
    this.deletions.clear()
  }

  private ready(): boolean {
    return this.redisClient.isOpen && this.redisClient.isReady
  }

  /**
   * Writes a value to Redis.
   *
   * Sets an expiry if ttl is set in options.
   * @param value The value to insert in the set.
   */
  private async _add(value: string) {
    await this.redisClient.sAdd(this.prefix, value)
    if (this.options.ttl) {
      await this.redisClient.expire(this.prefix, this.options.ttl)
    }
  }

  /**
   * Deletes a key from Redis.
   * @param key The key to delete.
   */
  private async _delete(value: string) {
    await this.redisClient.sRem(this.prefix, value)
  }

  async add(value: string): Promise<void> {
    if (this.ready()) {
      await this._add(value)
    } else {
      this.memoryCache.add(value)
    }
  }

  async delete(value: string): Promise<void> {
    if (this.ready()) {
      await this._delete(value)
    } else {
      // Try to delete from memory cache, if not found add to deletions set
      if (!this.memoryCache.delete(value)) this.deletions.add(value)
    }
  }

  async has(value: string): Promise<boolean> {
    if (this.ready()) {
      return await this.redisClient.sIsMember(this.prefix, value)
    } else {
      return this.memoryCache.has(value)
    }
  }
}
