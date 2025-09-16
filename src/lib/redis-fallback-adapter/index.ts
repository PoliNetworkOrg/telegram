import { EventEmitter } from "node:events"
import type { StorageAdapter } from "grammy"
import type { LogFn } from "pino"
import type { RedisClientOptions, RedisClientType, RedisFunctions, RedisModules, RedisScripts } from "redis"
import { createClient } from "redis"
import sjs from "secure-json-parse"
import type { ZodType } from "zod/v4"

interface Logger {
  info: LogFn
  error: LogFn
}
const defaultLogger: Logger = {
  info: console.log,
  error: console.error,
}

interface RedisFallbackAdapterOptions<T, M extends RedisModules, F extends RedisFunctions, S extends RedisScripts> {
  redis: RedisClientType<M, F, S> | RedisClientOptions<M, F, S>
  prefix?: string
  zType?: ZodType<T>
  logger?: Logger
}

export class RedisFallbackAdapter<
  T,
  M extends RedisModules = RedisModules,
  F extends RedisFunctions = RedisFunctions,
  S extends RedisScripts = RedisScripts,
> implements StorageAdapter<T>
{
  private static instanceCount = 0
  private prefix: string
  private memoryCache: Map<string, T> = new Map()
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

  private async flushMemoryCache() {
    await Promise.all(this.memoryCache.entries().map(([key, value]) => this._write(key, value)))
    this.memoryCache.clear()
    await Promise.all(this.deletions.values().map((k) => this._delete(k)))
    this.deletions.clear()
  }

  private async _write(key: string, value: T) {
    await this.redisClient.set(this.getKey(key), this.stringify(value))
  }

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
      if (this.memoryCache.has(key)) this.memoryCache.delete(key)
      else this.deletions.add(key)
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
