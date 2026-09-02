import type { Message } from "grammy/types"
import { beforeEach, describe, expect, it } from "vitest"

import {
  canMessageBeForwarded,
  deletedMessages,
  isMessageDeleted,
  isServiceMessage,
  markMessageAsDeleted,
} from "@/utils/messages"

describe("messages utils", () => {
  beforeEach(() => {
    deletedMessages.clear()
  })

  describe("isServiceMessage", () => {
    it("returns false for regular text and media messages", () => {
      const textMsg = {
        message_id: 1,
        date: 123456,
        chat: { id: -1001, type: "supergroup" },
        text: "Hello world",
      } as unknown as Message

      const photoMsg = {
        message_id: 2,
        date: 123456,
        chat: { id: -1001, type: "supergroup" },
        photo: [],
      } as unknown as Message

      expect(isServiceMessage(textMsg)).toBe(false)
      expect(isServiceMessage(photoMsg)).toBe(false)
    })

    it("returns true for service messages (e.g. joins, leaves, pins)", () => {
      const joinMsg = {
        message_id: 3,
        date: 123456,
        chat: { id: -1001, type: "supergroup" },
        new_chat_members: [{ id: 123, is_bot: false, first_name: "RaidBot" }],
      } as unknown as Message

      const leaveMsg = {
        message_id: 4,
        date: 123456,
        chat: { id: -1001, type: "supergroup" },
        left_chat_member: { id: 123, is_bot: false, first_name: "RaidBot" },
      } as unknown as Message

      const pinMsg = {
        message_id: 5,
        date: 123456,
        chat: { id: -1001, type: "supergroup" },
        pinned_message: {} as unknown as Message,
      } as unknown as Message

      expect(isServiceMessage(joinMsg)).toBe(true)
      expect(isServiceMessage(leaveMsg)).toBe(true)
      expect(isServiceMessage(pinMsg)).toBe(true)
    })
  })

  describe("canMessageBeForwarded", () => {
    it("returns true for standard forwardable messages", () => {
      const msg = {
        message_id: 10,
        date: 123456,
        chat: { id: -1001, type: "supergroup" },
        text: "Legit message",
      } as unknown as Message

      expect(canMessageBeForwarded(msg)).toBe(true)
    })

    it("returns false for service messages", () => {
      const msg = {
        message_id: 11,
        date: 123456,
        chat: { id: -1001, type: "supergroup" },
        new_chat_members: [],
      } as unknown as Message

      expect(canMessageBeForwarded(msg)).toBe(false)
    })

    it("returns false for messages with protected content", () => {
      const msg = {
        message_id: 12,
        date: 123456,
        chat: { id: -1001, type: "supergroup" },
        text: "Protected message",
        has_protected_content: true,
      } as unknown as Message

      expect(canMessageBeForwarded(msg)).toBe(false)
    })

    it("returns false for already-deleted messages", () => {
      const msg = {
        message_id: 13,
        date: 123456,
        chat: { id: -1001, type: "supergroup" },
        text: "Deleted message",
      } as unknown as Message

      markMessageAsDeleted(-1001, 13)
      expect(canMessageBeForwarded(msg)).toBe(false)
    })
  })

  describe("DeletedMessagesTracker", () => {
    it("correctly tracks marked deleted messages", () => {
      expect(isMessageDeleted(-1001, 42)).toBe(false)
      markMessageAsDeleted(-1001, 42)
      expect(isMessageDeleted(-1001, 42)).toBe(true)
      expect(isMessageDeleted(-1001, 43)).toBe(false)
      expect(isMessageDeleted(-1002, 42)).toBe(false)
    })
  })
})
