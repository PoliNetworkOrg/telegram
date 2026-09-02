import { beforeEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({
  addMessages: vi.fn(),
  addUsers: vi.fn(),
  getMessage: vi.fn(),
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
        get: { query: backend.getMessage },
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
  inFlightMessages: Message[]
  userStorage: Map<number, unknown>
  get(chatId: number, messageId: number): Promise<Message | null>
  syncMessages(): Promise<void>
}

const firstMessage = { chatId: -1001, messageId: 1 } as Message
const secondMessage = { chatId: -1001, messageId: 2 } as Message
const storage = MessageUserStorage.getInstance() as unknown as TestStorage

describe("MessageUserStorage", () => {
  beforeEach(() => {
    storage.memoryStorage = []
    storage.inFlightMessages = []
    storage.userStorage.clear()
    backend.addMessages.mockReset()
    backend.addUsers.mockReset()
    backend.getMessage.mockReset()
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

  it("returns a message while its backend write is in flight", async () => {
    let finishWrite: ((value: { error: null }) => void) | undefined
    backend.addMessages.mockImplementationOnce(
      () =>
        new Promise<{ error: null }>((resolve) => {
          finishWrite = resolve
        })
    )
    storage.memoryStorage.push(firstMessage)

    const flush = storage.syncMessages()
    await vi.waitFor(() => expect(backend.addMessages).toHaveBeenCalledTimes(1))

    await expect(storage.get(-1001, 1)).resolves.toBe(firstMessage)
    expect(backend.getMessage).not.toHaveBeenCalled()

    finishWrite?.({ error: null })
    await flush
    expect(storage.inFlightMessages).toEqual([])
  })
})
