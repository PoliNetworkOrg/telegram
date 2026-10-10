import { describe, expect, it, vi } from "vitest"
import { PERMISSION } from "@/access/catalog"
import { DENIED, decide, hasPermission, idpDecision, NO_ACCESS, sameAllowed } from "@/access/decision"

const allowed = { allowed: true, basis: "idp_permission" as const }
const base = { check: "command:ban", ids: { actorId: 42 }, logger: { warn: vi.fn() }, same: sameAllowed }

describe("migration authorization", () => {
  it.each([
    [allowed, DENIED],
    [DENIED, allowed],
  ])("shadow always applies the legacy decision", async (legacy, idp) => {
    const warn = vi.fn()
    const result = await decide({
      ...base,
      logger: { warn },
      mode: "shadow",
      legacy: async () => legacy,
      idp: async () => idp,
    })
    expect(result).toBe(legacy)
    expect(warn).toHaveBeenCalledOnce()
  })

  it("an unavailable IdP never changes a shadow decision", async () => {
    expect(
      await decide({
        ...base,
        mode: "shadow",
        legacy: async () => allowed,
        idp: async () => {
          throw new Error("offline")
        },
      })
    ).toBe(allowed)
  })

  it("shadow preserves a failed legacy check", async () => {
    await expect(
      decide({
        ...base,
        mode: "shadow",
        legacy: async () => {
          throw new Error("legacy offline")
        },
        idp: async () => allowed,
      })
    ).rejects.toThrow("legacy offline")
  })

  it("enforcement never reads the legacy roles", async () => {
    const legacy = vi.fn(async () => allowed)
    expect(await decide({ ...base, mode: "enforce", legacy, idp: async () => DENIED })).toBe(DENIED)
    expect(legacy).not.toHaveBeenCalled()
  })

  it("anonymous mode never contacts the IdP", async () => {
    const idp = vi.fn(async () => DENIED)
    expect(await decide({ ...base, mode: "anonymous", legacy: async () => allowed, idp })).toBe(allowed)
    expect(idp).not.toHaveBeenCalled()
  })

  it("native chat admins can moderate when the IdP is unavailable", async () => {
    expect(
      await idpDecision({
        required: [PERMISSION.moderate],
        actor: async () => {
          throw new Error("offline")
        },
        isChatAdmin: async () => true,
      })
    ).toEqual({ allowed: true, basis: "telegram_chat_admin" })
  })

  it("unlinked users are denied and every required permission is necessary", async () => {
    expect(await idpDecision({ required: [PERMISSION.moderate], actor: async () => NO_ACCESS })).toEqual(DENIED)
    expect(
      await idpDecision({
        required: [PERMISSION.moderate, PERMISSION.moderateGlobal],
        actor: async () => ({ ...NO_ACCESS, permissions: new Set([PERMISSION.moderate]) }),
      })
    ).toEqual(DENIED)
  })

  it("immunity implies message trust but never a moderation privilege", () => {
    const entry = { ...NO_ACCESS, permissions: new Set([PERMISSION.immune]) }
    expect(hasPermission(entry, PERMISSION.trusted)).toBe(true)
    expect(hasPermission(entry, PERMISSION.moderateGlobal)).toBe(false)
  })
})
