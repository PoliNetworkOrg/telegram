import type { Message, User } from "grammy/types"

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
