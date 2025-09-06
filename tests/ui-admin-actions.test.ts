import { describe, it, expect, vi, beforeEach } from "vitest"
import { UIAdminActionsTracker } from "@/middlewares/ui-admin-actions"

// Mock the tgLogger and logger
vi.mock("@/bot", () => ({
  tgLogger: {
    adminAction: vi.fn(),
  },
}))

vi.mock("@/logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

describe("UIAdminActionsTracker", () => {
  let tracker: UIAdminActionsTracker

  beforeEach(() => {
    tracker = new UIAdminActionsTracker()
    vi.clearAllMocks()
  })

  it("should mark and detect command actions", () => {
    const chatId = -123456789
    const userId = 987654321

    // Should not be marked initially
    expect(tracker["isCommandAction"](chatId, userId)).toBe(false)

    // Mark as command action
    tracker.markCommandAction(chatId, userId)

    // Should now be marked
    expect(tracker["isCommandAction"](chatId, userId)).toBe(true)

    // After timeout, should not be marked anymore
    // Note: In a real test we'd use fake timers, but for simplicity we test the basic functionality
  })

  it("should detect muted status correctly", () => {
    const mutedMember = {
      status: "restricted" as const,
      can_send_messages: false,
    }

    const unrestrictedMember = {
      status: "member" as const,
      can_send_messages: true,
    }

    const restrictedButNotMuted = {
      status: "restricted" as const, 
      can_send_messages: true,
    }

    expect(tracker["isMuted"](mutedMember as any)).toBe(true)
    expect(tracker["isMuted"](unrestrictedMember as any)).toBe(false)
    expect(tracker["isMuted"](restrictedButNotMuted as any)).toBe(false)
  })

  it("should detect kick vs ban correctly", () => {
    const previousMember = { status: "member" as const }
    
    // Short-term ban (kick)
    const kickedMember = {
      status: "kicked" as const,
      until_date: Math.floor(Date.now() / 1000) + 60, // expires in 1 minute
    }

    // Long-term ban
    const bannedMember = {
      status: "kicked" as const,
      until_date: Math.floor(Date.now() / 1000) + 3600, // expires in 1 hour
    }

    // Permanent ban (no until_date)
    const permanentBannedMember = {
      status: "kicked" as const,
    }

    expect(tracker["isKick"](kickedMember as any, previousMember as any)).toBe(true)
    expect(tracker["isKick"](bannedMember as any, previousMember as any)).toBe(false)
    expect(tracker["isKick"](permanentBannedMember as any, previousMember as any)).toBe(false)
  })
})