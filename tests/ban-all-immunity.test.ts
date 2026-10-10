import { beforeEach, describe, expect, it, vi } from "vitest"
import { type DecisionMode, decide, NO_ACCESS } from "@/access/decision"

const state = vi.hoisted(() => ({ mode: "shadow" as DecisionMode, legacyRoles: vi.fn(), resolveOne: vi.fn() }))
vi.mock("@/access", async () => {
  const actual = await import("@/access/decision")
  const catalog = await import("@/access/catalog")
  return {
    ...actual,
    ...catalog,
    legacyRoles: state.legacyRoles,
    resolveOne: state.resolveOne,
    decideAccess: (options: Parameters<typeof decide>[0]) =>
      decide({ ...options, mode: state.mode, logger: { warn: vi.fn() } }),
  }
})
vi.mock("@/backend", () => ({ serviceBackend: {} }))

import { isBanAllImmune } from "@/modules/moderation/ban-all-immunity"

beforeEach(() => {
  state.mode = "shadow"
  state.legacyRoles.mockReset()
  state.resolveOne.mockReset()
})

describe("ban-all immunity at enqueue", () => {
  it.each([
    "command",
    "report_menu",
    "campaign_review",
    "campaign_automatic",
  ] as const)("enforces immunity for %s", async (entryPoint) => {
    state.mode = "enforce"
    state.resolveOne.mockResolvedValue({ ...NO_ACCESS, permissions: new Set(["tg:immune"]) })
    expect(await isBanAllImmune(42, entryPoint)).toBe(true)
    expect(state.legacyRoles).not.toHaveBeenCalled()
  })

  it.each([
    "report_menu",
    "campaign_review",
    "campaign_automatic",
  ] as const)("shadow preserves the original lack of immunity for %s", async (entryPoint) => {
    state.resolveOne.mockResolvedValue({ ...NO_ACCESS, permissions: new Set(["tg:immune"]) })
    expect(await isBanAllImmune(42, entryPoint)).toBe(false)
    expect(state.legacyRoles).not.toHaveBeenCalled()
  })

  it("shadow preserves the command's legacy immunity even when the IdP disagrees", async () => {
    state.legacyRoles.mockResolvedValue(["owner"])
    state.resolveOne.mockResolvedValue(NO_ACCESS)
    expect(await isBanAllImmune(42, "command")).toBe(true)
  })

  it("enforcement propagates an unavailable lookup so the enqueue can refuse to start", async () => {
    state.mode = "enforce"
    state.resolveOne.mockRejectedValue(new Error("snapshot unavailable"))
    await expect(isBanAllImmune(42, "campaign_automatic")).rejects.toThrow("snapshot unavailable")
  })
})
