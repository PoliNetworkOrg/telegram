import type { duration } from "@/utils/duration"
import type { BotError, Context } from "grammy"
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

export type ExceptionLog<C extends Context> =
  | {
      type: "BOT_ERROR"
      error: BotError<C>
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
      type: "KICK" | "BAN" | "MUTE"
      reason?: string
    }
  | {
      type: "TEMP_BAN" | "TEMP_MUTE"
      duration: Duration
      reason?: string
    }
  | {
      type: "UNBAN" | "UNMUTE"
    }
)
