import type { MessageXFragment } from "@grammyjs/hydrate/out/data/message"
import type { Message, User } from "grammy/types"
import type { MaybePromise } from "./types"
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
 * @param timeout Timeout in ms, defaults to 30 seconds
 * @returns a void promise that resolves after the message is deleted (or if the deletion fails)
 */
export async function ephemeral(message: MaybePromise<MessageXFragment>, timeout = 30000): Promise<void> {
  const msg = await Promise.resolve(message)
  await wait(timeout)
    .then(() => msg.delete())
    .catch(() => {})
}
