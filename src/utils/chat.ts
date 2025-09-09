import type { ChatPermissions, Message } from "grammy/types"

import { type SimpleMessage, getSimpleMessages } from "./messages"

export function padChatId(chatId: number): number {
  if (chatId < 0) return chatId

  const str = chatId.toString()
  if (str.length === 13) return -chatId

  const padding = "1" + "0".repeat(12 - str.length)

  // Prepend the padding to the input string
  return parseInt(`-${padding}${chatId}`)
}

export function stripChatId(chatId: number): number {
  if (chatId > 0) return chatId
  const positive = -chatId

  const str = positive.toString()
  if (str.length < 13) return positive
  return parseInt(str.slice(1))
}

export const RestrictPermissions: Record<string, ChatPermissions> = {
  mute: {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
  },
  unmute: {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
  },
}

export function groupMessagesByChat(messages: (Message | SimpleMessage)[]): Map<number, number[]> {
  const msgs = getSimpleMessages(messages)
  const chatsMap = new Map<number, number[]>()
  msgs.forEach((msg) => {
    const ids = chatsMap.get(msg.chatId) ?? []
    ids.push(msg.messageId)
    chatsMap.set(msg.chatId, ids)
  })

  return chatsMap
}
