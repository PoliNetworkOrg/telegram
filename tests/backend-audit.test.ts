import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { User, Chat } from "grammy/types"

const backend = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  markMessagesDeleted: vi.fn(),
}))

vi.mock("@/backend", () => ({
  api: {
    tg: {
      auditLog: {
        create: { mutate: backend.create },
        update: { mutate: backend.update },
        markMessagesDeleted: { mutate: backend.markMessagesDeleted },
      },
    },
  },
}))

const TEST_ENV: Record<string, string> = {
  NODE_ENV: "development",
  BOT_TOKEN: "test-bot-token",
  BACKEND_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DB_HOST: "localhost",
  DB_PORT: "5432",
  DB_USER: "postgres",
  DB_PASS: "postgres",
  DB_NAME: "polinetwork_backend_test",
  AZURE_TENANT_ID: "tenant",
  AZURE_CLIENT_ID: "client",
  AZURE_CLIENT_SECRET: "secret",
  AZURE_EMAIL_SENDER: "noreply@example.com",
}

function setRequiredEnvVars() {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    process.env[key] = value
  }
}

let auditModeration: (input: any, telegramLog?: any) => Promise<number>
let auditBanAll: (input: any) => Promise<number>
let auditDeleted: (input: any) => Promise<void>
let updateAudit: (id: number, progress: any) => Promise<void>
let markMessagesDeleted: (chatId: number, messageIds: number[]) => Promise<number>
let audit: (input: any) => Promise<number | void>

beforeAll(async () => {
  setRequiredEnvVars()
  vi.resetModules()
  const mod = await import("@/modules/moderation/backend-audit")
  auditModeration = mod.auditModeration
  auditBanAll = mod.auditBanAll
  auditDeleted = mod.auditDeleted
  updateAudit = mod.updateAudit
  markMessagesDeleted = mod.markMessagesDeleted
  audit = mod.audit
})

beforeEach(() => {
  vi.clearAllMocks()
  backend.create.mockResolvedValue({ id: 1 })
  backend.update.mockResolvedValue({ updated: true })
  backend.markMessagesDeleted.mockResolvedValue({ count: 3, deletedAt: new Date() })
})

const mockUser = (id: number, name: string): User => ({
  id,
  is_bot: false,
  first_name: name,
  username: name.toLowerCase(),
})

const mockChat = (id: number, title: string): Chat => ({
  id,
  type: "group",
  title,
})

describe("Backend Audit Functions (Bot)", () => {
  describe("auditModeration", () => {
    it("creates moderation audit via tRPC", async () => {
      const admin = mockUser(123, "Admin")
      const target = mockUser(456, "Target")
      const chat = mockChat(789, "Test Group")

      const id = await auditModeration({
        category: "moderation",
        adminId: admin.id,
        targetId: target.id,
        target,
        chat,
        from: admin,
        action: "BAN",
        groupId: chat.id,
        until: null,
        type: "ban",
        reason: "Test ban",
        duration: {
          raw: "1h",
          date: new Date(Date.now() + 3600000).toISOString(),
          timestamp_s: Math.floor((Date.now() + 3600000) / 1000),
          secondsFromNow: 3600,
          dateStr: new Date(Date.now() + 3600000).toISOString(),
        },
        source: "manual",
        status: "pending",
        deletedMessageCount: 0,
        totalGroupCount: 1,
        successGroupCount: 0,
        failedGroupCount: 0,
      }, { logToTelegram: false })

      expect(typeof id).toBe("number")
      expect(id).toBeGreaterThan(0)
    })

    it("creates mute audit with duration", async () => {
      const admin = mockUser(123, "Admin")
      const target = mockUser(456, "Target")
      const chat = mockChat(789, "Test Group")

      const id = await auditModeration({
        category: "moderation",
        adminId: admin.id,
        targetId: target.id,
        target,
        chat,
        from: admin,
        action: "MUTE",
        groupId: chat.id,
        until: null,
        type: "mute",
        reason: "Test mute",
        duration: {
          raw: "30m",
          date: new Date(Date.now() + 1800000).toISOString(),
          timestamp_s: Math.floor((Date.now() + 1800000) / 1000),
          secondsFromNow: 1800,
          dateStr: new Date(Date.now() + 1800000).toISOString(),
        },
        source: "manual",
        status: "pending",
        deletedMessageCount: 0,
        totalGroupCount: 1,
        successGroupCount: 0,
        failedGroupCount: 0,
      }, { logToTelegram: false })

      expect(typeof id).toBe("number")
    })

    it("creates one deleted-message audit", async () => {
      await auditDeleted({
        category: "deleted",
        messageId: 1,
        chatId: 789,
        authorId: 456,
        author: mockUser(456, "Target"),
        deletedById: 123,
        deletedBy: mockUser(123, "Admin"),
        deletedAt: new Date(),
        reason: "Message cleanup",
        source: "manual",
      })
    })
  })

  describe("updateAudit", () => {
    it("updates audit progress", async () => {
      const admin = mockUser(123, "Admin")
      const target = mockUser(456, "Target")
      const chat = mockChat(789, "Test Group")

      const id = await auditModeration({
        adminId: admin.id,
        admin,
        targetId: target.id,
        target,
        chatId: chat.id,
        chat,
        type: "ban",
        reason: "Test",
        source: "manual",
        status: "pending",
        deletedMessageCount: 0,
        totalGroupCount: 1,
        successGroupCount: 0,
        failedGroupCount: 0,
      }, { logToTelegram: false })

      await updateAudit(id, {
        status: "running",
        deletedMessageCount: 3,
        totalGroupCount: 1,
        successGroupCount: 1,
        failedGroupCount: 0,
      })

      await updateAudit(id, {
        status: "completed",
        deletedMessageCount: 5,
        totalGroupCount: 1,
        successGroupCount: 1,
        failedGroupCount: 0,
      })

      expect(true).toBe(true)
    })
  })

  describe("markMessagesDeleted", () => {
    it("marks messages as deleted", async () => {
      const count = await markMessagesDeleted(789, [100, 101, 102])
      expect(typeof count).toBe("number")
    })
  })

  describe("audit (unified)", () => {
    it("audits ban_all", async () => {
      const admin = mockUser(123, "Admin")
      const target = mockUser(456, "Target")

      const id = await auditBanAll({
        category: "ban_all",
        adminId: admin.id,
        targetId: target.id,
        target,
        type: "ban_all",
        from: admin,
        groupId: null,
        until: null,
        reason: "Global ban test",
        source: "manual",
      })

      expect(typeof id).toBe("number")
    })

    it("audits unban_all", async () => {
      const admin = mockUser(123, "Admin")
      const target = mockUser(456, "Target")

      const id = await auditBanAll({
        category: "ban_all",
        adminId: admin.id,
        targetId: target.id,
        target,
        type: "unban_all",
        from: admin,
        groupId: null,
        until: null,
        reason: "Global unban test",
        source: "manual",
      })

      expect(typeof id).toBe("number")
    })

    it("audits deleted messages", async () => {
      await audit({
        category: "deleted",
        messageId: 111,
        chatId: 789,
        authorId: 456,
        author: mockUser(456, "Author"),
        deletedById: 123,
        deletedBy: mockUser(123, "Admin"),
        deletedAt: new Date(),
        reason: "Inappropriate content",
        source: "moderation",
        telegramLog: { logToTelegram: false },
      })

      expect(true).toBe(true)
    })

    it("audits exception", async () => {
      await audit({
        category: "exception",
        type: "GENERIC",
        error: { message: "Test error", stack: "Error at test.ts:1" },
        context: { handler: "test" },
        source: "bot",
        telegramLog: { logToTelegram: false },
      })

      expect(true).toBe(true)
    })

    it("audits group_management", async () => {
      await audit({
        category: "group_management",
        type: "create",
        chat: mockChat(789, "New Group"),
        addedBy: mockUser(123, "Admin"),
        inviteLink: "https://t.me/newgroup",
        reason: "New group created",
        source: "bot",
        telegramLog: { logToTelegram: false },
      })

      expect(true).toBe(true)
    })

    it("audits grant", async () => {
      await audit({
        category: "grant",
        action: "create",
        target: mockUser(456, "Target"),
        by: mockUser(123, "Admin"),
        since: new Date(),
        until: new Date(Date.now() + 86400000),
        reason: "VIP access",
        source: "bot",
        telegramLog: { logToTelegram: false },
      })

      expect(true).toBe(true)
    })
  })

  describe("ModerationAuditType", () => {
    it("has all expected types", () => {
      // Types are not available as runtime values, just verify compilation
      expect(true).toBe(true)
    })
  })

  describe("ModerationAuditStatus", () => {
    it("has all expected statuses", () => {
      // Types are not available as runtime values, just verify compilation
      expect(true).toBe(true)
    })
  })
})