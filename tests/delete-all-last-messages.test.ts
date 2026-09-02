import { beforeEach, describe, expect, it, vi } from "vitest"

const dependencies = vi.hoisted(() => ({
  deleteMessages: vi.fn(),
  getLastByUser: vi.fn(),
  sync: vi.fn(),
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
vi.mock("@/modules", () => ({
  modules: {
    shared: { api: { deleteMessages: dependencies.deleteMessages } },
  },
}))

import { Moderation } from "@/modules/moderation"

describe("deleteAllLastMessages", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    dependencies.sync.mockResolvedValue(undefined)
  })

  it("does not call Telegram when the backend returns no messages", async () => {
    dependencies.getLastByUser.mockResolvedValue({ error: null, messages: [] })

    await Moderation.deleteAllLastMessages(42, -1001, { requireSuccess: true })

    expect(dependencies.deleteMessages).not.toHaveBeenCalled()
  })

  it("deletes every message returned by the backend", async () => {
    dependencies.getLastByUser.mockResolvedValue({
      error: null,
      messages: [{ messageId: 11 }, { messageId: 12 }],
    })
    dependencies.deleteMessages.mockResolvedValue(true)

    await Moderation.deleteAllLastMessages(42, -1001, { requireSuccess: true })

    expect(dependencies.deleteMessages).toHaveBeenCalledWith(-1001, [11, 12])
  })

  it("fails before querying stale data when the message flush fails", async () => {
    dependencies.sync.mockRejectedValue(new Error("flush failed"))

    await expect(Moderation.deleteAllLastMessages(42, -1001, { requireSuccess: true })).rejects.toThrow("flush failed")
    expect(dependencies.getLastByUser).not.toHaveBeenCalled()
  })
})
