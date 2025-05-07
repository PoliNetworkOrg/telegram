import type { ChatPermissions } from "grammy/types"

export function padChatId(chatId: number): number {
  if (chatId < 0) return chatId

  const str = chatId.toString()
  if (str.length === 13) return -chatId

  const padding = "1" + "0".repeat(12 - str.length)

  // Prepend the padding to the input string
  return parseInt(`-${padding}${chatId}`)
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
