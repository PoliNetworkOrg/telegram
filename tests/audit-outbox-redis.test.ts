import { randomUUID } from "node:crypto"
import { createClient } from "redis"
import { describe, expect, it } from "vitest"
import { type OutboxItem, RedisOutboxStore } from "@/modules/audit/outbox"

/** Opt in only against a disposable Redis, never a deployed bot's database. */
const redisUrl = process.env.AUDIT_TEST_REDIS_URL

describe.skipIf(!redisUrl)("audit Redis persistence", () => {
  it("atomically preserves, reschedules, dead-letters and removes a record across client restart", async () => {
    const key = `tg-bot:test:${randomUUID()}`
    const item: OutboxItem = {
      input: {
        idempotencyKey: key,
        type: "ban",
        targetId: 42,
        groupId: -1001,
        until: "2026-10-12T12:00:00.000Z",
        basis: "idp_permission",
        actorTelegramId: 7,
      },
      attempts: 2,
      createdAt: 1000,
    }
    const client = createClient({ url: redisUrl })
    const restarted = createClient({ url: redisUrl })
    try {
      await client.connect()
      const original = new RedisOutboxStore(client)
      await original.put(item, 2000)
      await original.put({ ...item, attempts: 0 }, 0, true)
      expect((await original.due(1999, 100)).some((entry) => entry.input.idempotencyKey === key)).toBe(false)
      await client.quit()
      await restarted.connect()
      const store = new RedisOutboxStore(restarted)
      expect((await store.due(2000, 100)).find((entry) => entry.input.idempotencyKey === key)).toEqual(item)
      await store.bury(item, "input rejected")
      expect((await store.due(3000, 100)).some((entry) => entry.input.idempotencyKey === key)).toBe(false)
      expect(JSON.parse((await restarted.hGet("audit-outbox:dead", key)) ?? "null")).toEqual({
        ...item,
        reason: "input rejected",
      })
      await store.put(item, 0)
      await store.remove(key)
      expect((await store.due(3000, 100)).some((entry) => entry.input.idempotencyKey === key)).toBe(false)
    } finally {
      if (client.isOpen) await client.quit()
      if (restarted.isOpen) {
        await new RedisOutboxStore(restarted).remove(key)
        await restarted.hDel("audit-outbox:dead", key)
        await restarted.quit()
      }
    }
  })
})
