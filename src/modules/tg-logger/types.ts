import type { GrammyError, HttpError } from "grammy"
import type { Chat, Message, User } from "grammy/types"
import type { Duration } from "@/utils/duration"

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

export type GrantLog = {} & (
  | {
      action: "USAGE"
      from: User
      message: Message
      chat: Chat
    }
  | {
      action: "CREATE"
      target: User
      by: User
      since: Date
      duration: Duration
      reason?: string
    }
  | {
      action: "INTERRUPT"
      target: User
      by: User
    }
)
