import { UnrecoverableError } from "bullmq"
import { GrammyError } from "grammy"
import { describe, expect, it, vi } from "vitest"
import { executeBanAllJob } from "@/modules/moderation/ban-all-executor"

type ExecutorApi = Parameters<typeof executeBanAllJob>[0]

function createApi() {
  return {
    banChatMember: vi.fn(async () => true),
    unbanChatMember: vi.fn(async () => true),
  } as unknown as ExecutorApi
}

function telegramError(errorCode: number, description: string) {
  return new GrammyError(
    "Call to 'banChatMember' failed!",
    { ok: false, error_code: errorCode, description },
    "banChatMember",
    {}
  )
}

describe("BanAll executor", () => {
  it("explicitly deletes the banned user's stored messages", async () => {
    const api = createApi()
    const deleteAllLastMessages = vi.fn(async () => {})

    await executeBanAllJob(api, { name: "ban", data: { chatId: -1001, targetId: 42 } }, deleteAllLastMessages)

    expect(api.banChatMember).toHaveBeenCalledWith(-1001, 42, { revoke_messages: true })
    expect(deleteAllLastMessages).toHaveBeenCalledWith(42, -1001)
  })

  it("does not delete messages when unbanning", async () => {
    const api = createApi()
    const deleteAllLastMessages = vi.fn(async () => {})

    await executeBanAllJob(api, { name: "unban", data: { chatId: -1001, targetId: 42 } }, deleteAllLastMessages)

    expect(api.unbanChatMember).toHaveBeenCalledWith(-1001, 42)
    expect(deleteAllLastMessages).not.toHaveBeenCalled()
  })

  it("fails the child job when manual deletion throws so BullMQ can retry it", async () => {
    const api = createApi()
    const deleteAllLastMessages = vi.fn(async () => {
      throw new Error("delete failed")
    })

    await expect(
      executeBanAllJob(api, { name: "ban", data: { chatId: -1001, targetId: 42 } }, deleteAllLastMessages)
    ).rejects.toThrow("delete failed")
  })

  it("fails permanent Telegram client errors without retrying the child job", async () => {
    const api = createApi()
    vi.mocked(api.banChatMember).mockRejectedValue(
      telegramError(400, "Bad Request: not enough rights to restrict/unrestrict chat member")
    )

    await expect(
      executeBanAllJob(
        api,
        { name: "ban", data: { chatId: -1001, targetId: 42 } },
        vi.fn(async () => {})
      )
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it("keeps Telegram flood-control errors retryable", async () => {
    const api = createApi()
    const error = telegramError(429, "Too Many Requests: retry after 1")
    vi.mocked(api.banChatMember).mockRejectedValue(error)

    await expect(
      executeBanAllJob(
        api,
        { name: "ban", data: { chatId: -1001, targetId: 42 } },
        vi.fn(async () => {})
      )
    ).rejects.toBe(error)
  })
})
