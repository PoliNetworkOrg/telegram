import { describe, expect, it, vi } from "vitest"
import { AuditOutbox, type AuditRecordInput, type OutboxItem, type OutboxStore } from "@/modules/audit/outbox"

class Store implements OutboxStore {
  items = new Map<string, { item: OutboxItem; at: number }>()
  dead: OutboxItem[] = []
  async put(item: OutboxItem, at: number, onlyIfAbsent = false) {
    if (onlyIfAbsent && this.items.has(item.input.idempotencyKey)) return
    this.items.set(item.input.idempotencyKey, { item, at })
  }
  async due(now: number, limit: number) {
    return [...this.items.values()]
      .filter(({ at }) => at <= now)
      .slice(0, limit)
      .map(({ item }) => item)
  }
  async remove(key: string) {
    this.items.delete(key)
  }
  async bury(item: OutboxItem) {
    this.dead.push(item)
    this.items.delete(item.input.idempotencyKey)
  }
}
const input: AuditRecordInput = {
  idempotencyKey: "tg-bot:test",
  type: "ban",
  targetId: 42,
  groupId: -1001,
  until: new Date("2026-10-12T12:00:00Z"),
  basis: "telegram_chat_admin",
  actorTelegramId: 7,
}
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }

describe("audit delivery", () => {
  it("survives a restart and retries with the original key, actor, basis and date", async () => {
    let now = 1000
    const store = new Store()
    const failed = new AuditOutbox({
      store,
      now: () => now,
      send: async () => {
        throw new Error("backend offline")
      },
      isPermanent: () => false,
      logger,
    })
    await failed.enqueue(input)
    await failed.flush()
    expect(store.items.get(input.idempotencyKey)?.item.attempts).toBe(1)
    const send = vi.fn(async () => ({ duplicate: false }))
    const restarted = new AuditOutbox({ store, now: () => now, send, isPermanent: () => false, logger })
    expect(await restarted.flush()).toBe(0)
    now += 1000
    expect(await restarted.flush()).toBe(1)
    expect(send).toHaveBeenCalledWith(input)
    expect(store.items.size).toBe(0)
  })

  it("a failed deletion safely redelivers the same idempotency key", async () => {
    const store = new Store()
    await store.put({ input: { ...input, until: input.until?.toISOString() ?? null }, attempts: 0, createdAt: 0 }, 0)
    const remove = vi.spyOn(store, "remove").mockRejectedValueOnce(new Error("redis offline"))
    const send = vi.fn(async (_record: AuditRecordInput) => ({ duplicate: true }))
    const outbox = new AuditOutbox({ store, send, isPermanent: () => false, logger })
    await outbox.flush()
    expect(store.items.size).toBe(1)
    await outbox.flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map(([record]) => record.idempotencyKey)).toEqual([
      input.idempotencyKey,
      input.idempotencyKey,
    ])
    expect(remove).toHaveBeenCalledTimes(2)
    expect(store.items.size).toBe(0)
  })

  it("preserves permanently rejected records for operator inspection", async () => {
    const store = new Store()
    const outbox = new AuditOutbox({
      store,
      send: async () => {
        throw new Error("bad input")
      },
      isPermanent: () => true,
      logger,
    })
    await outbox.enqueue(input)
    await outbox.flush()
    expect(store.items.size).toBe(0)
    expect(store.dead[0]?.input.idempotencyKey).toBe(input.idempotencyKey)
  })

  it("shares concurrent flushes and waits for delivery during stop", async () => {
    const store = new Store()
    let finish = () => {}
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const send = vi.fn(() => pending)
    const outbox = new AuditOutbox({ store, send, isPermanent: () => false, logger })
    await outbox.enqueue(input)
    expect(outbox.flush()).toBe(outbox.flush())
    let stopped = false
    const stopping = outbox.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    finish()
    await stopping
    expect(send).toHaveBeenCalledOnce()
    expect(store.items.size).toBe(0)
  })

  it("duplicate enqueue keeps the pending retry attempts and backoff", async () => {
    const store = new Store()
    const item: OutboxItem = {
      input: { ...input, until: input.until?.toISOString() ?? null },
      attempts: 3,
      createdAt: 0,
    }
    await store.put(item, Date.now() + 60_000)
    const outbox = new AuditOutbox({ store, send: vi.fn(async () => undefined), isPermanent: () => false, logger })
    await outbox.enqueue(input)
    await outbox.flush()
    expect(store.items.get(input.idempotencyKey)?.item).toBe(item)
    expect(store.items.get(input.idempotencyKey)?.at).toBeGreaterThan(Date.now())
  })

  it("tries direct delivery with the same key when Redis cannot persist", async () => {
    const store = new Store()
    vi.spyOn(store, "put").mockRejectedValue(new Error("redis offline"))
    const send = vi.fn(async () => undefined)
    const outbox = new AuditOutbox({ store, send, isPermanent: () => false, logger })
    await outbox.enqueue(input)
    expect(send).toHaveBeenCalledWith(input)
  })
})
