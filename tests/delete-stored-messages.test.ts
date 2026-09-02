import { describe, expect, it, vi } from "vitest"
import { deleteStoredMessages } from "@/modules/moderation/delete-stored-messages"

type DeleteMessagesApi = Parameters<typeof deleteStoredMessages>[0]

function createApi() {
  return { deleteMessages: vi.fn(async () => true) } as unknown as DeleteMessagesApi
}

describe("deleteStoredMessages", () => {
  it("calls Telegram deleteMessages with every stored message ID", async () => {
    const api = createApi()

    await expect(deleteStoredMessages(api, -1001, [11, 12, 13])).resolves.toBe(true)
    expect(api.deleteMessages).toHaveBeenCalledWith(-1001, [11, 12, 13])
  })

  it("does not send an invalid empty delete request", async () => {
    const api = createApi()

    await expect(deleteStoredMessages(api, -1001, [])).resolves.toBe(true)
    expect(api.deleteMessages).not.toHaveBeenCalled()
  })
})
