import type { Chat, Message, User } from "grammy/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

const dependencies = vi.hoisted(() => ({
  deleteMessages: vi.fn(),
  createAudit: vi.fn(),
  banChatMember: vi.fn(),
  getChatMember: vi.fn(),
  getLastByUser: vi.fn(),
  markMessagesDeleted: vi.fn(),
  moderationAction: vi.fn(),
  preDelete: vi.fn(),
  restrictChatMember: vi.fn(),
  sync: vi.fn(),
  unbanChatMember: vi.fn(),
}))

vi.mock("@/backend", () => ({
  api: {
    tg: {
      messages: { getLastByUser: { query: dependencies.getLastByUser } },
    },
  },
}))
vi.mock("@/middlewares/message-user-storage", () => ({
  MessageUserStorage: { getInstance: () => ({ syncMessages: dependencies.sync }) },
}))
vi.mock("@/modules/moderation/backend-log", () => ({
  backendModerationLog: {
    create: dependencies.createAudit,
    markMessagesDeleted: dependencies.markMessagesDeleted,
  },
}))
vi.mock("@/modules", () => ({
  modules: {
    get: () => ({
      groupId: -2001,
      moderationAction: dependencies.moderationAction,
      preDelete: dependencies.preDelete,
    }),
    shared: {
      botInfo: { id: 999 },
      api: {
        banChatMember: dependencies.banChatMember,
        deleteMessages: dependencies.deleteMessages,
        getChatMember: dependencies.getChatMember,
        restrictChatMember: dependencies.restrictChatMember,
        unbanChatMember: dependencies.unbanChatMember,
      },
    },
  },
}))

import { Moderation } from "@/modules/moderation"

describe("deleteAllLastMessages", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    dependencies.sync.mockResolvedValue(undefined)
    dependencies.markMessagesDeleted.mockResolvedValue(0)
    dependencies.createAudit.mockResolvedValue(1)
    dependencies.banChatMember.mockResolvedValue(true)
    dependencies.getChatMember.mockResolvedValue({ status: "member" })
    dependencies.moderationAction.mockResolvedValue(undefined)
    dependencies.restrictChatMember.mockResolvedValue(true)
    dependencies.unbanChatMember.mockResolvedValue(true)
    dependencies.preDelete.mockResolvedValue({
      count: 1,
      link: "https://t.me/example",
      logMessageIds: [101, 102],
      recentMessageCount: 0,
      successfulChatIds: [],
      failedChatIds: [],
    })
  })

  it("does not call Telegram when the backend returns no messages", async () => {
    dependencies.getLastByUser.mockResolvedValue({ error: null, messages: [] })

    const count = await Moderation.deleteAllLastMessages(42, -1001, { requireSuccess: true })

    expect(dependencies.deleteMessages).not.toHaveBeenCalled()
    expect(count).toBe(0)
  })

  it("deletes every message returned by the backend", async () => {
    dependencies.getLastByUser.mockResolvedValue({
      error: null,
      messages: [{ messageId: 11 }, { messageId: 12 }],
    })
    dependencies.deleteMessages.mockResolvedValue(true)
    dependencies.markMessagesDeleted.mockResolvedValue(2)

    const count = await Moderation.deleteAllLastMessages(42, -1001, { requireSuccess: true })

    expect(dependencies.deleteMessages).toHaveBeenCalledWith(-1001, [11, 12])
    expect(dependencies.markMessagesDeleted).toHaveBeenCalledWith(-1001, [11, 12])
    expect(count).toBe(2)
  })

  it("does not retry messages already marked as deleted", async () => {
    dependencies.getLastByUser.mockResolvedValue({
      error: null,
      messages: [
        { messageId: 11, deletedAt: new Date() },
        { messageId: 12, deletedAt: null },
      ],
    })
    dependencies.deleteMessages.mockResolvedValue(true)
    dependencies.markMessagesDeleted.mockResolvedValue(1)

    const count = await Moderation.deleteAllLastMessages(42, -1001, { requireSuccess: true })

    expect(dependencies.deleteMessages).toHaveBeenCalledWith(-1001, [12])
    expect(count).toBe(1)
  })

  it("fails before querying stale data when the message flush fails", async () => {
    dependencies.sync.mockRejectedValue(new Error("flush failed"))

    await expect(Moderation.deleteAllLastMessages(42, -1001, { requireSuccess: true })).rejects.toThrow("flush failed")
    expect(dependencies.getLastByUser).not.toHaveBeenCalled()
  })

  it("distinguishes cleanup failure from a genuine zero count", async () => {
    dependencies.sync.mockRejectedValue(new Error("flush failed"))

    const count = await Moderation.deleteAllLastMessages(42, -1001)

    expect(count).toBeNull()
    expect(dependencies.getLastByUser).not.toHaveBeenCalled()
  })

  it("writes standalone message deletions to the backend audit log", async () => {
    dependencies.deleteMessages.mockResolvedValue(true)
    dependencies.markMessagesDeleted.mockResolvedValue(1)
    const message = { message_id: 11, chat: { id: -1001 }, from: { id: 42 } } as Message
    const executor = { id: 7 } as User

    const result = await Moderation.deleteMessages([message], executor, "Command /del")

    expect(result.isOk()).toBe(true)
    expect(dependencies.createAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 7,
        targetId: 42,
        groupId: -1001,
        type: "delete",
        status: "completed",
        deletedMessageCount: 1,
      })
    )
  })

  it("records an unavailable recent-message count when the backend marker fails", async () => {
    dependencies.deleteMessages.mockResolvedValue(true)
    dependencies.markMessagesDeleted.mockRejectedValue(new Error("backend unavailable"))
    const message = { message_id: 11, chat: { id: -1001 }, from: { id: 42 } } as Message

    await Moderation.deleteMessages([message], { id: 7 } as User, "Command /del")

    expect(dependencies.createAudit).toHaveBeenCalledWith(
      expect.objectContaining({ deletedMessageCount: null, status: "completed" })
    )
  })

  it("keeps the Telegram deletion log and avoids a second audit inside a ban", async () => {
    dependencies.deleteMessages.mockResolvedValue(true)
    dependencies.markMessagesDeleted.mockResolvedValue(1)
    dependencies.getLastByUser.mockResolvedValue({ error: null, messages: [] })
    const message = { message_id: 11, chat: { id: -1001 }, from: { id: 42 } } as Message
    const target = { id: 42 } as User
    const moderator = { id: 7 } as User

    const result = await Moderation.ban(target, { id: -1001 } as Chat, moderator, null, [message], "spam")

    expect(result.isOk()).toBe(true)
    expect(dependencies.preDelete).toHaveBeenCalledWith([message], "BAN -- spam", moderator)
    expect(dependencies.moderationAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BAN",
        preDeleteRes: expect.objectContaining({ link: "https://t.me/example" }),
      })
    )
    expect(dependencies.createAudit).toHaveBeenCalledTimes(1)
    expect(dependencies.createAudit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ban", status: "completed", deletedMessageCount: 1 })
    )
  })

  it.each([
    ["ban", () => Moderation.ban({ id: 42 } as User, { id: -1001 } as Chat, { id: 7 } as User, null)],
    ["unban", () => Moderation.unban({ id: 42 } as User, { id: -1001 } as Chat, { id: 7 } as User)],
    ["kick", () => Moderation.kick({ id: 42 } as User, { id: -1001 } as Chat, { id: 7 } as User)],
    ["mute", () => Moderation.mute({ id: 42 } as User, { id: -1001 } as Chat, { id: 7 } as User, null)],
    ["unmute", () => Moderation.unmute({ id: 42 } as User, { id: -1001 } as Chat, { id: 7 } as User)],
  ])("writes one completed %s audit", async (type, run) => {
    dependencies.getLastByUser.mockResolvedValue({ error: null, messages: [] })

    const result = await run()

    expect(result.isOk()).toBe(true)
    expect(dependencies.createAudit).toHaveBeenCalledTimes(1)
    expect(dependencies.createAudit).toHaveBeenCalledWith(expect.objectContaining({ type, status: "completed" }))
  })

  it("writes a failed audit when a moderation action fails", async () => {
    dependencies.restrictChatMember.mockResolvedValue(false)

    const result = await Moderation.mute({ id: 42 } as User, { id: -1001 } as Chat, { id: 7 } as User, null)

    expect(result.isErr()).toBe(true)
    expect(dependencies.moderationAction).not.toHaveBeenCalled()
    expect(dependencies.createAudit).toHaveBeenCalledTimes(1)
    expect(dependencies.createAudit).toHaveBeenCalledWith(expect.objectContaining({ type: "mute", status: "failed" }))
  })

  it("writes a partial ban audit when cleanup succeeds but the ban fails", async () => {
    dependencies.banChatMember.mockResolvedValue(false)
    dependencies.getLastByUser.mockResolvedValue({ error: null, messages: [{ messageId: 11 }] })
    dependencies.deleteMessages.mockResolvedValue(true)
    dependencies.markMessagesDeleted.mockResolvedValue(1)

    const result = await Moderation.ban({ id: 42 } as User, { id: -1001 } as Chat, { id: 7 } as User, null)

    expect(result.isErr()).toBe(true)
    expect(dependencies.createAudit).toHaveBeenCalledTimes(1)
    expect(dependencies.createAudit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ban", status: "partial", deletedMessageCount: 1 })
    )
  })

  it("writes a failed ban audit when neither the ban nor cleanup takes effect", async () => {
    dependencies.banChatMember.mockResolvedValue(false)
    dependencies.sync.mockRejectedValue(new Error("flush failed"))

    const result = await Moderation.ban({ id: 42 } as User, { id: -1001 } as Chat, { id: 7 } as User, null)

    expect(result.isErr()).toBe(true)
    expect(dependencies.createAudit).toHaveBeenCalledTimes(1)
    expect(dependencies.createAudit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ban", status: "failed", deletedMessageCount: null })
    )
  })

  it("writes a partial ban audit when Telegram cleanup succeeds but marking fails", async () => {
    dependencies.banChatMember.mockResolvedValue(false)
    dependencies.getLastByUser.mockResolvedValue({ error: null, messages: [{ messageId: 11 }] })
    dependencies.deleteMessages.mockResolvedValue(true)
    dependencies.markMessagesDeleted.mockRejectedValue(new Error("mark failed"))

    const result = await Moderation.ban({ id: 42 } as User, { id: -1001 } as Chat, { id: 7 } as User, null)

    expect(result.isErr()).toBe(true)
    expect(dependencies.createAudit).toHaveBeenCalledTimes(1)
    expect(dependencies.createAudit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ban", status: "partial", deletedMessageCount: null })
    )
  })

  it("writes one partial multi-chat audit with per-group results", async () => {
    const messages = [
      { message_id: 11, chat: { id: -1001 }, from: { id: 42 } },
      { message_id: 12, chat: { id: -1002 }, from: { id: 42 } },
    ] as Message[]
    dependencies.preDelete.mockResolvedValue({
      count: 2,
      link: "https://t.me/example",
      logMessageIds: [101, 102, 103],
      recentMessageCount: 0,
      successfulChatIds: [],
      failedChatIds: [],
    })
    dependencies.deleteMessages.mockResolvedValue(true)
    dependencies.markMessagesDeleted.mockResolvedValue(1)
    dependencies.restrictChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const result = await Moderation.multiChatSpam({ id: 42 } as User, messages, { timestamp_s: 123 } as never)

    expect(result.isErr()).toBe(true)
    expect(dependencies.createAudit).toHaveBeenCalledTimes(1)
    expect(dependencies.createAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "multi_chat_spam",
        status: "partial",
        totalGroupCount: 2,
        successGroupCount: 1,
        failedGroupCount: 1,
        deletedMessageCount: 2,
      })
    )
  })

  it("combines deletion and mute results in a multi-chat audit", async () => {
    const messages = [
      { message_id: 11, chat: { id: -1001 }, from: { id: 42 } },
      { message_id: 12, chat: { id: -1002 }, from: { id: 42 } },
    ] as Message[]
    dependencies.preDelete.mockResolvedValue({
      count: 2,
      link: "https://t.me/example",
      logMessageIds: [101, 102, 103],
      recentMessageCount: 0,
      successfulChatIds: [],
      failedChatIds: [],
    })
    dependencies.deleteMessages.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    dependencies.markMessagesDeleted.mockResolvedValue(1)
    dependencies.restrictChatMember.mockResolvedValue(true)

    const result = await Moderation.multiChatSpam({ id: 42 } as User, messages, { timestamp_s: 123 } as never)

    expect(result.isOk()).toBe(true)
    expect(dependencies.createAudit).toHaveBeenCalledTimes(1)
    expect(dependencies.createAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "multi_chat_spam",
        status: "partial",
        totalGroupCount: 2,
        successGroupCount: 1,
        failedGroupCount: 1,
      })
    )
  })
})
