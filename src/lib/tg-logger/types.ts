import type { duration } from "@/utils/duration"
import type { BotError, Context, GrammyError, HttpError } from "grammy"
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
  | { type: "UNHANDLED_PROMISE"; error: Error; promise: Promise<unknown> }

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
      reason?: string
    }
  | {
      action: "BAN_DELETE"
      duration?: Duration
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
