import type { Chat, Message, User } from "grammy/types"
import type { Duration } from "@/utils/duration"

export type PreDeleteResult = {
  count: number
  logMessageIds: number[]
  link: string
}

export type ModerationAction = {
  from: User
  target: User
  chat: Chat
  preDeleteRes?: PreDeleteResult | null
} & (
  | {
      action: "BAN" | "MUTE"
      duration?: Duration
      reason?: string
    }
  | {
      action: "KICK"
      reason?: string
    }
  | {
      action: "UNBAN" | "UNMUTE"
    }
  | {
      action: "MULTI_CHAT_SPAM"
      duration: Duration
      messages: Message[]
    }
  | {
      action: "SILENT"
      reason?: string
    }
)

export type ModerationErrorCode = "CANNOT_MOD_YOURSELF" | "CANNOT_MOD_BOT" | "CANNOT_MOD_GROUPADMIN" | "PERFORM_ERROR"
export type ModerationError = { code: ModerationErrorCode; fmtError: string; strError: string }
