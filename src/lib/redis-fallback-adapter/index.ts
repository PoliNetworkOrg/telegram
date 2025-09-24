import { EventEmitter } from "node:events"
import type { StorageAdapter } from "grammy"
import type { LogFn } from "pino"
import type { RedisClientOptions, RedisClientType, RedisFunctions, RedisModules, RedisScripts } from "redis"
import { createClient } from "redis"
import sjs from "secure-json-parse"
import type { ZodType } from "zod"

interface Logger {
  info: LogFn
  error: LogFn
}
const defaultLogger: Logger = {
  info: console.log,
  error: console.error,
}

/**
 * Options for RedisFallbackAdapter
 */
interface RedisFallbackAdapterOptions<T, M extends RedisModules, F extends RedisFunctions, S extends RedisScripts> {
  /** Redis client instance, or options to create one */
  redis: RedisClientType<M, F, S> | RedisClientOptions<M, F, S>
  /** Time to live for each entry in seconds, uses redis' EXPIRE command */
  ttl?: number
  /**
   * Prefix for each key stored in redis, to avoid collisions, if not provided a
   * default one will be used to ensure uniqueness across multiple instances
   */
  prefix?: string
  /** Optional zod schema to validate data read from redis */
  zType?: ZodType<T>
  /** Optional custom logger, compatible with defaults to console */
  logger?: Logger
}

/**
 * A storage adapter that uses Redis as primary storage, but falls back to in-memory
 * storage if Redis is not available, syncing the in-memory data to Redis once
 * the connection is re-established.
 *
 * _Compatible with grammy's StorageAdapter interface_
 */
export class RedisFallbackAdapter<
  T,
  M extends RedisModules = RedisModules,
  F extends RedisFunctions = RedisFunctions,
  S extends RedisScripts = RedisScripts,
> implements StorageAdapter<T>
{
  private static instanceCount = 0
  private prefix: string
  // In-memory cache used when Redis is not available
  private memoryCache: Map<string, T> = new Map()
  // temporary store for keys that need to be deleted once redis is back (used when delete does not find the key in memoryCache)
  private deletions: Set<string> = new Set()
  private redisClient: RedisClientType<M, F, S>
  private logger: Logger = defaultLogger

  constructor(private options: RedisFallbackAdapterOptions<T, M, F, S>) {
    const prefix = options.prefix ?? `redis-fb-adapter-${RedisFallbackAdapter.instanceCount++}`
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

  private parse(str: string): T | undefined {
    try {
      const parsed = sjs.parse(str) as T
      if (this.options.zType) {
        return this.options.zType.parse(parsed)
      }
      return parsed
    } catch (err) {
      this.logger.error({ err }, `[STORAGE_ADAPTER(${this.prefix})] error while parsing read`)
      return undefined
    }
  }

  private stringify(obj: T): string {
    return JSON.stringify(obj)
  }

  private getKey(k: string): string {
    return `${this.prefix}:${k}`
  }

  private ready(): boolean {
    return this.redisClient.isOpen && this.redisClient.isReady
  }

  /**
   * Flush the in-memory cache to Redis. Called automatically when the Redis
   * connection is re-established.
   */
  private async flushMemoryCache() {
    // write all memoryCache entries to redis
    await Promise.all(this.memoryCache.entries().map(([key, value]) => this._write(key, value)))
    this.memoryCache.clear()
    // delete all keys that were marked for deletion while redis was down
    await Promise.all(this.deletions.values().map((k) => this._delete(k)))
    this.deletions.clear()
  }

  /**
   * Writes a value to Redis.
   *
   * Sets an expiry if ttl is set in options.
   * @param key The key to write to.
   * @param value The value to write.
   */
  private async _write(key: string, value: T) {
    await this.redisClient.set(this.getKey(key), this.stringify(value))
    if (this.options.ttl) {
      await this.redisClient.expire(this.getKey(key), this.options.ttl)
    }
  }

  /**
   * Deletes a key from Redis.
   * @param key The key to delete.
   */
  private async _delete(key: string) {
    await this.redisClient.del(this.getKey(key))
  }

  async read(key: string): Promise<T | undefined> {
    if (this.ready()) {
      const v = await this.redisClient.get(this.getKey(key))
      return v ? this.parse(v) : undefined
    } else {
      return this.memoryCache.get(key)
    }
  }

  async write(key: string, value: T): Promise<void> {
    if (this.ready()) {
      await this._write(key, value)
    } else {
      this.memoryCache.set(key, value)
    }
  }

  async delete(key: string): Promise<void> {
    if (this.ready()) {
      await this._delete(key)
    } else {
      // Try to delete from memory cache, if not found add to deletions set
      if (!this.memoryCache.delete(key)) this.deletions.add(key)
    }
  }

  async has(key: string): Promise<boolean> {
    if (this.ready()) {
      return (await this.redisClient.exists(this.getKey(key))) > 0
    } else {
      return this.memoryCache.has(key)
    }
  }
}
