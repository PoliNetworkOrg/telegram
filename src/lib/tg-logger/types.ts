import type { duration } from "@/utils/duration"
import type { GrammyError, HttpError } from "grammy"
import type { Chat, Message, User } from "grammy/types"
import type { z } from "zod"

type Duration = z.output<typeof duration.zod>

export type BanAllLog = {
  target: User
  from: User
} & (
  | {
      type: "BAN"
      reason?: string
    }
  | {
      type: "UNBAN"
    }
)

export type ExceptionLog =
  | { type: "UNHANDLED_PROMISE"; error: Error; promise: Promise<unknown> }
  | {
      type: "BOT_ERROR"
      error: GrammyError
    }
  | {
      type: "HTTP_ERROR"
      error: HttpError
    }
  | {
      type: "GENERIC"
      error: Error
    }
  | {
      type: "UNKNOWN"
      error: unknown
    }

export type AutoModeration = {
  target: User
  message: Message
  reason?: string
} & (
  | {
      action: "DELETE"
    }
  | {
      action: "MUTE_DELETE"
      duration?: Duration
    }
  | {
      action: "KICK_DELETE"
    }
  | {
      action: "BAN_DELETE"
      duration?: Duration
    }
  | {
      action: "SILENT"
    }
)

export type AdminAction = {
  from: User
  target: User
  chat: Chat
} & (
  | {
      type: "BAN" | "MUTE"
      duration?: Duration
      reason?: string
    }
  | {
      type: "KICK"
      reason?: string
    }
  | {
      type: "UNBAN" | "UNMUTE"
    }
  | {
      type: "DELETE"
      message: Message
    }
)

export type GroupManagement = {
  chat: Chat
} & (
  | {
      type: "LEAVE" | "LEAVE_FAIL"
      addedBy: User
    }
  | {
      type: "DELETE"
    }
  | {
      type: "CREATE"
      addedBy: User
      inviteLink: string
    }
  | {
      type: "CREATE_FAIL"
      reason: string
      inviteLink?: string
    }
)
