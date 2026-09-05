import { describe, expect, it } from "vitest"
import { hasActiveBanAll } from "@/middlewares/campaign-spam/audit-history"

describe("campaign spam audit history", () => {
  it("uses the latest successful network-wide moderation action", () => {
    expect(
      hasActiveBanAll([
        { type: "unban_all", status: "failed" },
        { type: "ban_all", status: "completed" },
        { type: "unban_all", status: "completed" },
      ])
    ).toBe(true)
    expect(
      hasActiveBanAll([
        { type: "unban_all", status: "completed" },
        { type: "ban_all", status: "completed" },
      ])
    ).toBe(false)
    expect(hasActiveBanAll([{ type: "ban", status: "completed" }])).toBe(false)
  })
})
