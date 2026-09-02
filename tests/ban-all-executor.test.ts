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

function createJob(name: "ban" | "unban") {
  const job = {
    name,
    data: { chatId: -1001, targetId: 42 },
    updateData: vi.fn(async (data: { chatId: number; targetId: number; deletedMessageCount?: number | null }) => {
      job.data = data
    }),
  }
  return job
}

describe("BanAll executor", () => {
  it("explicitly deletes the banned user's stored messages", async () => {
    const api = createApi()
    const deleteAllLastMessages = vi.fn(async () => 12)

    const result = await executeBanAllJob(api, createJob("ban"), deleteAllLastMessages)

    expect(api.banChatMember).toHaveBeenCalledWith(-1001, 42, { revoke_messages: true })
    expect(deleteAllLastMessages).toHaveBeenCalledWith(42, -1001)
    expect(result).toEqual({ deletedMessageCount: 12 })
  })

  it("does not delete messages when unbanning", async () => {
    const api = createApi()
    const deleteAllLastMessages = vi.fn(async () => 0)

    const result = await executeBanAllJob(api, createJob("unban"), deleteAllLastMessages)

    expect(api.unbanChatMember).toHaveBeenCalledWith(-1001, 42)
    expect(deleteAllLastMessages).not.toHaveBeenCalled()
    expect(result).toEqual({ deletedMessageCount: 0 })
  })

  it("fails the child job when manual deletion throws so BullMQ can retry it", async () => {
    const api = createApi()
    const deleteAllLastMessages = vi.fn(async () => {
      throw new Error("delete failed")
    })

    await expect(executeBanAllJob(api, createJob("ban"), deleteAllLastMessages)).rejects.toThrow("delete failed")
  })

  it("fails permanent Telegram client errors without retrying the child job", async () => {
    const api = createApi()
    vi.mocked(api.banChatMember).mockRejectedValue(
      telegramError(400, "Bad Request: not enough rights to restrict/unrestrict chat member")
    )

    await expect(
      executeBanAllJob(
        api,
        createJob("ban"),
        vi.fn(async () => 0)
      )
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it("reuses a persisted deletion count when BullMQ retries the ban", async () => {
    const api = createApi()
    const deleteAllLastMessages = vi.fn(async () => 12)
    const job = createJob("ban")
    vi.mocked(api.banChatMember).mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(true)

    await expect(executeBanAllJob(api, job, deleteAllLastMessages)).rejects.toThrow("temporary failure")
    await expect(executeBanAllJob(api, job, deleteAllLastMessages)).resolves.toEqual({ deletedMessageCount: 12 })
    expect(deleteAllLastMessages).toHaveBeenCalledTimes(1)
    expect(job.updateData).toHaveBeenCalledWith(expect.objectContaining({ deletedMessageCount: 12 }))
  })

  it("keeps Telegram flood-control errors retryable", async () => {
    const api = createApi()
    const error = telegramError(429, "Too Many Requests: retry after 1")
    vi.mocked(api.banChatMember).mockRejectedValue(error)

    await expect(
      executeBanAllJob(
        api,
        createJob("ban"),
        vi.fn(async () => 0)
      )
    ).rejects.toBe(error)
  })
})
