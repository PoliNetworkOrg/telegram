import { beforeEach, describe, expect, it, vi } from "vitest"
import { NO_ACCESS } from "@/access/decision"

const state = vi.hoisted(() => ({ resolveOne: vi.fn() }))
vi.mock("@/access", async () => {
  const actual = await import("@/access/decision")
  const catalog = await import("@/access/catalog")
  return { ...actual, ...catalog, resolveOne: state.resolveOne }
})
vi.mock("@/backend", () => ({ serviceBackend: {} }))

import { isBanAllImmune } from "@/modules/moderation/ban-all-immunity"

beforeEach(() => {
  state.resolveOne.mockReset()
})

describe("ban-all immunity at enqueue", () => {
  it("`tg:immune` makes the target immune", async () => {
    state.resolveOne.mockResolvedValue({ ...NO_ACCESS, permissions: new Set(["tg:immune"]) })
    expect(await isBanAllImmune(42)).toBe(true)
  })

  it("a target without `tg:immune` is not immune", async () => {
    state.resolveOne.mockResolvedValue({ ...NO_ACCESS, permissions: new Set(["tg:trusted", "tg:moderate:global"]) })
    expect(await isBanAllImmune(42)).toBe(false)
  })

  it("propagates an unavailable lookup so the enqueue can refuse to start", async () => {
    state.resolveOne.mockRejectedValue(new Error("snapshot unavailable"))
    await expect(isBanAllImmune(42)).rejects.toThrow("snapshot unavailable")
  })
})
