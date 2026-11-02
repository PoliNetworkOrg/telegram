import type { Logger } from "pino"
import type { ApiInput } from "@/backend"

export type AuditRecordInput = ApiInput["tg"]["auditLog"]["record"]

/** One pending record. `until` is kept as an ISO string so the item survives JSON. */
export type OutboxItem = {
  input: Omit<AuditRecordInput, "until"> & { until: string | null }
  attempts: number
  createdAt: number
}

export interface OutboxStore {
  /** Stores the item and schedules it at `at`; overwrites an item with the same key. */
  put(item: OutboxItem, at: number, onlyIfAbsent?: boolean): Promise<void>
  /** Items scheduled at or before `now`, earliest first. */
  due(now: number, limit: number): Promise<OutboxItem[]>
  remove(key: string): Promise<void>
  /** Moves an item the backend will never accept out of the queue, keeping it for inspection. */
  bury(item: OutboxItem, reason: string): Promise<void>
}

const PREFIX = "audit-outbox"
const ITEMS = `${PREFIX}:items`
const DUE = `${PREFIX}:due`
const DEAD = `${PREFIX}:dead`

// Each script keeps the item hash and the schedule in step, so a crash never orphans an entry.
const PUT_SCRIPT = `if ARGV[4] == '1' and redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1`
const REMOVE_SCRIPT = `redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1`
const BURY_SCRIPT = `redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
return 1`
const DUE_SCRIPT = `local keys = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local items = {}
for _, key in ipairs(keys) do
  local item = redis.call('HGET', KEYS[1], key)
  if item then table.insert(items, item) else redis.call('ZREM', KEYS[2], key) end
end
return items`

export type OutboxRedis = {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** The outbox in the bot's Redis (AOF on in production, RFC v3 §10.2). */
export class RedisOutboxStore implements OutboxStore {
  constructor(private readonly redis: OutboxRedis) {}

  async put(item: OutboxItem, at: number, onlyIfAbsent = false) {
    await this.redis.eval(PUT_SCRIPT, {
      keys: [ITEMS, DUE],
      arguments: [item.input.idempotencyKey, JSON.stringify(item), String(at), onlyIfAbsent ? "1" : "0"],
    })
  }

  async due(now: number, limit: number): Promise<OutboxItem[]> {
    const raw = await this.redis.eval(DUE_SCRIPT, { keys: [ITEMS, DUE], arguments: [String(now), String(limit)] })
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item) as OutboxItem)
  }

  async remove(key: string) {
    await this.redis.eval(REMOVE_SCRIPT, { keys: [ITEMS, DUE], arguments: [key] })
  }

  async bury(item: OutboxItem, reason: string) {
    await this.redis.eval(BURY_SCRIPT, {
      keys: [ITEMS, DUE, DEAD],
      arguments: [item.input.idempotencyKey, JSON.stringify({ ...item, reason })],
    })
  }
}

export type AuditOutboxOptions = {
  store: OutboxStore
  /** Delivers one record; must be idempotent on `idempotencyKey` (the backend's `tg.auditLog.record`). */
  send: (input: AuditRecordInput) => Promise<unknown>
  /** Errors a retry cannot fix, e.g. a rejected input. Everything else is retried. */
  isPermanent: (error: unknown) => boolean
  logger: Pick<Logger, "info" | "warn" | "error">
  now?: () => number
  /** How long a store write may take before the record is sent directly instead. Default 2 s. */
  storeTimeoutMs?: number
  batchSize?: number
  maxBackoffMs?: number
}

const BASE_BACKOFF_MS = 1_000
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000
const DEFAULT_STORE_TIMEOUT_MS = 2_000
const DEFAULT_BATCH_SIZE = 50
const FLUSH_INTERVAL_MS = 5_000

const toItem = (input: AuditRecordInput, now: number): OutboxItem => ({
  input: { ...input, until: input.until ? input.until.toISOString() : null },
  attempts: 0,
  createdAt: now,
})
const toInput = (item: OutboxItem): AuditRecordInput => ({
  ...item.input,
  until: item.input.until ? new Date(item.input.until) : null,
})

/**
 * Audit records go through an outbox (RFC v3 §10.2): stored first, then delivered and retried with
 * backoff until the backend accepts them. A backend outage delays records but loses none, and the
 * idempotency key makes every retry, and any duplicate delivery, safe.
 */
export class AuditOutbox {
  private readonly now: () => number
  private flushing: Promise<number> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: AuditOutboxOptions) {
    this.now = options.now ?? Date.now
  }

  /** Never throws: a record that can be neither stored nor sent is logged in full instead. */
  async enqueue(input: AuditRecordInput): Promise<void> {
    const item = toItem(input, this.now())
    try {
      await withTimeout(
        this.options.store.put(item, item.createdAt, true),
        this.options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS
      )
    } catch (storeError) {
      // Without the store, deliver now. If the write lands later as well, the key deduplicates it.
      try {
        await this.options.send(input)
      } catch (sendError) {
        this.options.logger.error(
          { storeError, sendError, record: item.input },
          "[AUDIT] record could not be stored nor delivered and is lost"
        )
      }
      return
    }
    void this.flush()
  }

  /** Delivers due records; concurrent calls share one run. Resolves to the number delivered. */
  flush(): Promise<number> {
    this.flushing ??= this.deliverDue().finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  private async deliverDue(): Promise<number> {
    let delivered = 0
    let items: OutboxItem[]
    try {
      items = await this.options.store.due(this.now(), this.options.batchSize ?? DEFAULT_BATCH_SIZE)
    } catch (error) {
      this.options.logger.warn({ error }, "[AUDIT] outbox unavailable")
      return 0
    }

    for (const item of items) {
      const key = item.input.idempotencyKey
      try {
        await this.options.send(toInput(item))
      } catch (error) {
        await this.failed(item, error).catch((storeError: unknown) =>
          this.options.logger.warn({ error: storeError, key }, "[AUDIT] cannot reschedule record")
        )
        continue
      }
      delivered++
      // If this fails the record is sent again later, and the backend answers `duplicate`.
      await this.options.store
        .remove(key)
        .catch((error: unknown) => this.options.logger.warn({ error, key }, "[AUDIT] cannot remove delivered record"))
    }
    return delivered
  }

  private async failed(item: OutboxItem, error: unknown) {
    const key = item.input.idempotencyKey
    if (this.options.isPermanent(error)) {
      this.options.logger.error({ error, key }, "[AUDIT] record rejected by the backend, moved aside")
      await this.options.store.bury(item, error instanceof Error ? error.message : String(error))
      return
    }
    const attempts = item.attempts + 1
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS)
    this.options.logger.warn({ error, key, attempts, retryInMs: backoff }, "[AUDIT] record delivery failed")
    await this.options.store.put({ ...item, attempts }, this.now() + backoff)
  }

  start(intervalMs = FLUSH_INTERVAL_MS) {
    this.timer ??= setInterval(() => void this.flush(), intervalMs)
    void this.flush()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.flushing
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
