import type { Chat, Message, User } from "grammy/types"
import type { AuditBasis } from "@/modules/audit"
import type { Duration } from "@/utils/duration"

/** Who performs an action and why they may: the audit `basis` (RFC v3 §10.2). */
export type Moderator = { user: User; basis: AuditBasis }

export type PreDeleteResult = {
  count: number
  logMessageIds: number[]
  link?: string
}

export type ModerationAction = {
  from: User
  basis: AuditBasis
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
