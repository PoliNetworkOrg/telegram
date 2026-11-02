import type { Context } from "grammy"
import type { Message } from "grammy/types"
import { describe, expect, it, vi } from "vitest"
import { ephemeral } from "@/utils/messages"

vi.mock("@/modules", () => ({ modules: {} }))

function messageContext(chatType: "private" | "group" | "supergroup") {
  const reply = vi.fn()
  const context = {
    chat: { id: chatType === "private" ? 42 : -100, type: chatType },
    from: { id: 42 },
    reply,
  } as unknown as Context

  return { context, reply }
}

describe("ephemeral", () => {
  it("targets the invoking user in groups and preserves reply options", async () => {
    const { context, reply } = messageContext("supergroup")
    const sentMessage = { message_id: 1 } as Message
    const signal = {} as NonNullable<Parameters<Context["reply"]>[2]>
    reply.mockResolvedValue(sentMessage)

    await expect(ephemeral(context, "hello", { disable_notification: true }, signal)).resolves.toBe(sentMessage)
    expect(reply).toHaveBeenCalledWith(
      "hello",
      {
        disable_notification: true,
        ephemeral_message_parameters: { receiver_user_id: 42 },
      },
      signal
    )
  })

  it("uses a regular reply outside groups", async () => {
    const { context, reply } = messageContext("private")
    const sentMessage = { message_id: 1 } as Message
    reply.mockResolvedValue(sentMessage)

    await expect(ephemeral(context, "hello", { disable_notification: true })).resolves.toBe(sentMessage)
    expect(reply).toHaveBeenCalledWith("hello", { disable_notification: true }, undefined)
  })

  it("returns null when sending fails", async () => {
    const { context, reply } = messageContext("group")
    reply.mockRejectedValue(new Error("Telegram unavailable"))

    await expect(ephemeral(context, "hello")).resolves.toBeNull()
  })
})
