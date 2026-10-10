import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BanAllFlow } from "@/modules/moderation/ban-all-flow"
import type { BanAll } from "@/modules/tg-logger/ban-all"

const state = vi.hoisted(() => ({
  authenticated: true,
  add: vi.fn(),
  audit: vi.fn(),
  getJob: vi.fn(),
  getGroups: vi.fn(),
  workers: new Map<string, (job: unknown) => Promise<unknown>>(),
}))
vi.mock("bullmq", () => ({
  Worker: class {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      state.workers.set(name, processor)
    }
    on() {}
  },
  Queue: class {
    on() {}
    getJob = state.getJob
    async getJobCountByTypes() {
      return 0
    }
  },
  FlowProducer: class {
    on() {}
    add = state.add
  },
}))
vi.mock("@/env", () => ({ env: { REDIS_PORT: 6379 } }))
vi.mock("@/backend", () => ({
  get serviceTokens() {
    return state.authenticated ? {} : null
  },
  serviceBackend: { tg: { groups: { getAll: { query: state.getGroups } } } },
}))
vi.mock("@/modules", () => ({ modules: { get: () => ({ record: state.audit }) } }))
vi.mock("@/modules/moderation", () => ({ Moderation: {} }))

import { BanAllQueue } from "@/modules/moderation/ban-all"

const banAll: BanAll = {
  type: "BAN",
  target: 42,
  reporter: { id: 7, is_bot: false, first_name: "Reporter" },
  state: { jobCount: 0, successCount: 0, failedCount: 0 },
}

beforeEach(() => {
  vi.clearAllMocks()
  state.authenticated = true
  state.getJob.mockResolvedValue(null)
  state.getGroups.mockResolvedValue([{ telegramId: -1001, hide: false }])
  state.add.mockResolvedValue(undefined)
  state.audit.mockResolvedValue(undefined)
})

describe("ban-all enqueue audit recovery", () => {
  it("does not report a failed queue insertion as a ban-all action", async () => {
    state.add.mockRejectedValueOnce(new Error("Redis rejected flow"))
    const queue = new BanAllQueue()
    await expect(queue.initiateBanAll(banAll, 99, "idp_permission", "operation")).rejects.toThrow("Redis rejected flow")
    expect(state.audit).not.toHaveBeenCalled()
    await queue.initiateBanAll(banAll, 100, "idp_permission", "operation")
    const first = state.add.mock.calls[0]?.[0] as BanAllFlow
    const retry = state.add.mock.calls[1]?.[0] as BanAllFlow
    expect(first.data.audit?.idempotencyKey).toBe(retry.data.audit?.idempotencyKey)
    expect(state.audit).toHaveBeenCalledOnce()
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 7, targetId: 42, basis: "idp_permission" }),
      retry.data.audit?.idempotencyKey
    )
  })

  it("recovers an accepted flow after a caller retry without enqueueing again", async () => {
    const queue = new BanAllQueue()
    await queue.initiateBanAll(banAll, 99, "telegram_chat_admin", "operation")
    const flow = state.add.mock.calls[0]?.[0] as BanAllFlow
    state.getJob.mockResolvedValue({ data: flow.data })
    expect(await queue.initiateBanAll(banAll, 100, "idp_permission", "operation")).toEqual({
      alreadyExisted: true,
      messageId: 99,
    })
    expect(state.add).toHaveBeenCalledOnce()
    expect(state.audit.mock.calls[1]).toEqual(state.audit.mock.calls[0])
  })

  it("anonymous flow records once and does not replay the non-idempotent legacy audit", async () => {
    state.authenticated = false
    const queue = new BanAllQueue()
    await queue.initiateBanAll(banAll, 99, "automatic", "operation")
    const flow = state.add.mock.calls[0]?.[0] as BanAllFlow
    expect(flow.data.audit).toBeUndefined()
    await state.workers.get("[ban_all.orchestrator]")?.({
      data: flow.data,
      name: "ban_all",
      getDependenciesCount: async () => ({ processed: 1 }),
      updateProgress: vi.fn(async () => undefined),
    })
    state.getJob.mockResolvedValue({ data: flow.data })
    await queue.initiateBanAll(banAll, 100, "automatic", "operation")
    expect(state.audit).toHaveBeenCalledOnce()
  })

  it("the resumed orchestrator recovers the original actor and audit key", async () => {
    const queue = new BanAllQueue()
    await queue.initiateBanAll(banAll, 99, "automatic", "operation")
    const flow = state.add.mock.calls[0]?.[0] as BanAllFlow
    const process = state.workers.get("[ban_all.orchestrator]")
    expect(process).toBeDefined()
    await process?.({
      data: flow.data,
      name: "ban_all",
      getDependenciesCount: async () => ({ processed: 1 }),
      updateProgress: vi.fn(async () => undefined),
    })
    expect(state.audit.mock.calls[1]).toEqual(state.audit.mock.calls[0])
  })
})
