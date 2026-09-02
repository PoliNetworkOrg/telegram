import { beforeEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({
  addMessages: vi.fn(),
  addUsers: vi.fn(),
}))

vi.mock("croner", () => ({ Cron: vi.fn() }))
vi.mock("@/modules/telemetry", () => ({
  TrackedMiddleware: class {
    protected composer = {
      on: vi.fn(() => ({ filter: vi.fn() })),
    }
  },
}))
vi.mock("@/backend", () => ({
  api: {
    tg: {
      messages: {
        add: { mutate: backend.addMessages },
      },
      users: {
        add: { mutate: backend.addUsers },
      },
    },
  },
}))

import { type Message, MessageUserStorage } from "@/middlewares/message-user-storage"

type TestStorage = {
  memoryStorage: Message[]
  userStorage: Map<number, unknown>
  syncMessages(): Promise<void>
}

const firstMessage = { messageId: 1 } as Message
const secondMessage = { messageId: 2 } as Message
const storage = MessageUserStorage.getInstance() as unknown as TestStorage

describe("MessageUserStorage", () => {
  beforeEach(() => {
    storage.memoryStorage = []
    storage.userStorage.clear()
    backend.addMessages.mockReset()
    backend.addUsers.mockReset()
  })

  it("restores messages and rejects when the backend flush fails", async () => {
    backend.addMessages.mockResolvedValue({ error: "ENCRYPT_ERROR" })
    storage.memoryStorage.push(firstMessage)

    await expect(storage.syncMessages()).rejects.toThrow("Backend returned ENCRYPT_ERROR")
    expect(storage.memoryStorage).toEqual([firstMessage])
  })

  it("queues a second flush for messages that arrive during the first flush", async () => {
    let finishFirst: ((value: { error: null }) => void) | undefined
    backend.addMessages
      .mockImplementationOnce(
        () =>
          new Promise<{ error: null }>((resolve) => {
            finishFirst = resolve
          })
      )
      .mockResolvedValueOnce({ error: null })
    storage.memoryStorage.push(firstMessage)

    const firstFlush = storage.syncMessages()
    await vi.waitFor(() => expect(backend.addMessages).toHaveBeenCalledTimes(1))
    storage.memoryStorage.push(secondMessage)
    const secondFlush = storage.syncMessages()
    expect(backend.addMessages).toHaveBeenCalledTimes(1)

    finishFirst?.({ error: null })
    await firstFlush
    await vi.waitFor(() => expect(backend.addMessages).toHaveBeenCalledTimes(2))
    await secondFlush

    expect(backend.addMessages.mock.calls[0][0].messages).toEqual([firstMessage])
    expect(backend.addMessages.mock.calls[1][0].messages).toEqual([secondMessage])
  })
})
