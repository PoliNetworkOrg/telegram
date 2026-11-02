import { describe, expect, it, vi } from "vitest"
import { authorizeAction } from "@/access"
import { PERMISSION } from "@/access/catalog"
import { DENIED, hasPermission, idpDecision, NO_ACCESS } from "@/access/decision"
import type { Backend } from "@/backend"

vi.mock("@/logger", () => ({ logger: { error: vi.fn() } }))

function backendResolving(query: () => Promise<unknown>): Backend {
  return { tg: { access: { resolve: { query } } } } as unknown as Backend
}

describe("IdP authorization", () => {
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

  it("an unavailable IdP decision denies the action", async () => {
    const backend = backendResolving(async () => {
      throw new Error("offline")
    })
    expect(
      await authorizeAction({ check: "command:/ban", actorId: 42, backend, required: [PERMISSION.moderate] })
    ).toEqual(DENIED)
  })

  it("the actor's resolved permissions authorize the action", async () => {
    const backend = backendResolving(async () => ({
      "42": { sub: "user", permissions: [PERMISSION.moderate], grant: null },
    }))
    expect(
      await authorizeAction({ check: "command:/ban", actorId: 42, backend, required: [PERMISSION.moderate] })
    ).toEqual({ allowed: true, basis: "idp_permission" })
  })
})
