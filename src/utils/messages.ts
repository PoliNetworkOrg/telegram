import type { Message, User } from "grammy/types"
import type { MaybePromise, PartialMessage } from "./types"
import { wait } from "./wait"

type TextReturn<M extends Message> = M extends { text: string }
  ? { text: string; type: "TEXT" }
  : M extends { caption: string }
    ? { text: string; type: "CAPTION" }
    : { text: string; type: "TEXT" | "CAPTION" } | { text: null; type: "OTHER" } // cannot infer

export function getText<M extends Message>(message: M): TextReturn<M> {
  if ("text" in message && message.text) return { text: message.text, type: "TEXT" } as TextReturn<M>
  if ("caption" in message && message.caption) return { text: message.caption, type: "CAPTION" } as TextReturn<M>

  return { text: null, type: "OTHER" } as TextReturn<M>
}
/**
 * Wraps message metadata into a fake message object compatible with grammy's Message type.
 * @param chatId The ID of the chat the message belongs to.
 * @param messageId The ID of the message.
 * @param from The user who sent the message.
 * @param date The date the message was sent.
 * @returns A fake message object with the specified metadata.
 */
export function createFakeMessage(chatId: number, messageId: number, from: User, date?: Date): Message {
  return {
    from,
    message_id: messageId,
    date: date ? date.getTime() / 1000 : Date.now(),
    chat: {
      id: chatId,
      type: "supergroup",
      title: "NO_TITLE",
    },
  }
}

/**
 * Deletes a sent message after a specified timeout. Useful for sending ephemeral
 * messages that should disappear after a while.
 *
 * Fails silently if the message cannot be deleted (e.g. due to missing permissions),
 * so it can be used without awaiting it.
 *
 * @param message The message to delete or its promise
 * @param timeout Timeout in ms, defaults to 20 seconds
 * @returns a void promise that resolves after the message is deleted (or if the deletion fails)
 */
export async function ephemeral(message: MaybePromise<PartialMessage>, timeout = 20000): Promise<void> {
  const msg = await Promise.resolve(message).catch(() => null)
  if (!msg) return
  await wait(timeout)
  try {
    const { modules } = await import("@/modules")
    await modules.shared.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {})
  } catch {}
}

export const SERVICE_MESSAGE_FIELDS: ReadonlyArray<string> = [
  "new_chat_members",
  "left_chat_member",
  "new_chat_title",
  "new_chat_photo",
  "delete_chat_photo",
  "group_chat_created",
  "supergroup_chat_created",
  "channel_chat_created",
  "message_auto_delete_timer_changed",
  "migrate_to_chat_id",
  "migrate_from_chat_id",
  "pinned_message",
  "invoice",
  "successful_payment",
  "users_shared",
  "chat_shared",
  "connected_website",
  "write_access_allowed",
  "passport_data",
  "proximity_alert_triggered",
  "boost_added",
  "chat_background_set",
  "forum_topic_created",
  "forum_topic_edited",
  "forum_topic_closed",
  "forum_topic_reopened",
  "general_forum_topic_hidden",
  "general_forum_topic_unhidden",
  "giveaway_created",
  "giveaway",
  "giveaway_winners",
  "giveaway_completed",
  "video_chat_scheduled",
  "video_chat_started",
  "video_chat_ended",
  "video_chat_participants_invited",
  "web_app_data",
]

/**
 * Checks if a message is a service message (e.g. user joined/left, pinned message, etc.)
 * which cannot be forwarded by Telegram Bot API.
 */
export function isServiceMessage(message: Message): boolean {
  for (const field of SERVICE_MESSAGE_FIELDS) {
    if (field in message && (message as unknown as Record<string, unknown>)[field] !== undefined) {
      return true
    }
  }
  return false
}

export class DeletedMessagesTracker {
  private deleted = new Map<string, number>()
  private readonly ttlMs = 10 * 60 * 1000 // 10 minutes TTL
  private readonly maxSize = 10_000

  mark(chatId: number, messageId: number): void {
    this.cleanup()
    this.deleted.set(`${chatId}:${messageId}`, Date.now())
  }

  isDeleted(chatId: number, messageId: number): boolean {
    const key = `${chatId}:${messageId}`
    const timestamp = this.deleted.get(key)
    if (!timestamp) return false
    if (Date.now() - timestamp > this.ttlMs) {
      this.deleted.delete(key)
      return false
    }
    return true
  }

  clear(): void {
    this.deleted.clear()
  }

  private cleanup(): void {
    if (this.deleted.size < this.maxSize) return
    const now = Date.now()
    for (const [key, timestamp] of this.deleted.entries()) {
      if (now - timestamp > this.ttlMs) {
        this.deleted.delete(key)
      }
    }
    if (this.deleted.size >= this.maxSize) {
      const keysToDelete = Array.from(this.deleted.keys()).slice(0, 1000)
      for (const k of keysToDelete) {
        this.deleted.delete(k)
      }
    }
  }
}

export const deletedMessages = new DeletedMessagesTracker()

export function markMessageAsDeleted(chatId: number, messageId: number): void {
  deletedMessages.mark(chatId, messageId)
}

export function isMessageDeleted(chatId: number, messageId: number): boolean {
  return deletedMessages.isDeleted(chatId, messageId)
}

/**
 * Checks if a message can be forwarded to the logging channel.
 * Skips service messages, messages with protected content, and already-deleted messages.
 */
export function canMessageBeForwarded(message: Message): boolean {
  if (isServiceMessage(message)) return false
  if ("has_protected_content" in message && Boolean(message.has_protected_content)) return false
  if (isMessageDeleted(message.chat.id, message.message_id)) return false
  return true
}
