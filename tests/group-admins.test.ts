import type { ChatMember } from "grammy/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { changesAdmins, createGroupAdminsSync, type GroupAdminsSyncDeps, toAdminIds } from "@/lib/group-admins"

const member = (id: number, status: ChatMember["status"], is_bot = false) =>
  ({ status, user: { id, is_bot, first_name: `User ${id}` } }) as ChatMember

function deps(overrides: Partial<GroupAdminsSyncDeps> = {}) {
  const cache = new Map<number, number[]>()
  return {
    cache,
    getChatAdministrators: vi.fn(async () => [member(1, "creator"), member(2, "administrator")]),
    listGroups: vi.fn(async () => [-1001, -1002]),
    store: {
      read: vi.fn(async (chatId: number) => cache.get(chatId)),
      write: vi.fn(async (chatId: number, userIds: number[]) => void cache.set(chatId, userIds)),
    },
    logger: { warn: vi.fn(), info: vi.fn() },
    wait: vi.fn(async () => {}),
    ...overrides,
  } satisfies GroupAdminsSyncDeps & { cache: Map<number, number[]> }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("toAdminIds", () => {
  it("keeps the creator and administrators, without bots", () => {
    expect(
      toAdminIds([
        member(1, "creator"),
        member(2, "administrator"),
        member(3, "administrator", true),
        member(4, "member"),
      ])
    ).toEqual([1, 2])
  })
})

describe("changesAdmins", () => {
  it("is true only when someone becomes or stops being an admin", () => {
    expect(changesAdmins(member(1, "member"), member(1, "administrator"))).toBe(true)
    expect(changesAdmins(member(1, "administrator"), member(1, "left"))).toBe(true)
    expect(changesAdmins(member(1, "administrator"), member(1, "creator"))).toBe(true)
    expect(changesAdmins(member(1, "member"), member(1, "restricted"))).toBe(false)
    expect(changesAdmins(member(1, "administrator"), member(1, "administrator"))).toBe(false)
    expect(changesAdmins(member(9, "member"), member(9, "administrator", true))).toBe(false)
  })
})

describe("createGroupAdminsSync", () => {
  it("caches what Telegram says about a chat's admins", async () => {
    const d = deps()
    expect(await createGroupAdminsSync(d).refreshChat(-1001)).toBe(true)
    expect(d.cache.get(-1001)).toEqual([1, 2])
  })

  it("keeps the previous entry when Telegram cannot list the admins", async () => {
    const d = deps({ getChatAdministrators: vi.fn(async () => Promise.reject(new Error("chat not found"))) })
    d.cache.set(-1001, [7])
    expect(await createGroupAdminsSync(d).refreshChat(-1001)).toBe(false)
    expect(d.cache.get(-1001)).toEqual([7])
    expect(d.logger.warn).toHaveBeenCalled()
  })

  it("coalesces a burst of admin changes in a chat into one read", async () => {
    vi.useFakeTimers()
    const d = deps()
    const sync = createGroupAdminsSync({ ...d, debounceMs: 1000 })
    sync.schedule(-1001)
    sync.schedule(-1001)
    await vi.advanceTimersByTimeAsync(500)
    sync.schedule(-1001)
    await vi.advanceTimersByTimeAsync(1000)
    expect(d.getChatAdministrators).toHaveBeenCalledTimes(1)
  })

  it("refreshes every group and keeps going after a failure", async () => {
    const d = deps({
      listGroups: vi.fn(async () => [-1001, -1002, -1003]),
      getChatAdministrators: vi
        .fn<GroupAdminsSyncDeps["getChatAdministrators"]>()
        .mockResolvedValueOnce([member(1, "creator")])
        .mockRejectedValueOnce(new Error("kicked"))
        .mockResolvedValueOnce([]),
    })
    expect(await createGroupAdminsSync(d).refreshAll()).toEqual({ refreshed: 2, total: 3 })
    expect([...d.cache.entries()]).toEqual([
      [-1001, [1]],
      [-1003, []],
    ])
    expect(d.wait).toHaveBeenCalledTimes(2)
  })

  it("skips a full refresh while another one runs", async () => {
    let release = () => {}
    const d = deps({ listGroups: vi.fn(() => new Promise<number[]>((resolve) => (release = () => resolve([])))) })
    const sync = createGroupAdminsSync(d)
    const first = sync.refreshAll()
    expect(await sync.refreshAll()).toBeNull()
    release()
    expect(await first).toEqual({ refreshed: 0, total: 0 })
  })

  it("answers the backend with the cached groups only, empty lists included", async () => {
    const d = deps()
    d.cache.set(-1001, [1, 2])
    d.cache.set(-1002, [])
    expect(await createGroupAdminsSync(d).cached([-1001, -1002, -1003])).toEqual([
      { chatId: -1001, userIds: [1, 2] },
      { chatId: -1002, userIds: [] },
    ])
  })
})
