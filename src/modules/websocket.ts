import { type TelegramSocket, WS_PATH } from "@polinetwork/backend"
import * as parser from "@socket.io/devalue-parser"
import type { User } from "grammy/types"
import { io } from "socket.io-client"
import { serviceTokens } from "@/backend"
import { env } from "@/env"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { MessageUserStorage } from "@/middlewares/message-user-storage"
import { duration } from "@/utils/duration"
import type { ModuleShared } from "@/utils/types"
import type { TgLogger } from "./tg-logger"
import type { GrantActor } from "./tg-logger/types"
import { SocketTokenAuth } from "./websocket-auth"

/** Who acted, as the backend sends it since RFC v3 §8.3. */
type SocketActor = { sub: string | null; telegramId: string | null; displayName: string }

/**
 * The author of a grant for the log: their stored Telegram user when there is one, else the name
 * the backend sent. `actor` is optional for backends that still send only `adminId`.
 */
async function grantActor(data: { actor?: SocketActor; adminId: number | null }): Promise<GrantActor | null> {
  const telegramId = data.actor ? (data.actor.telegramId === null ? null : Number(data.actor.telegramId)) : data.adminId
  const stored: User | null = telegramId ? await MessageUserStorage.getInstance().getStoredUser(telegramId) : null
  if (stored) return stored
  return data.actor ? { displayName: data.actor.displayName, telegramId } : null
}

type SocketError = {
  name: string
  message: string
  context: {
    UNSENT: number
    OPENED: number
    HEADERS_RECEIVED: number
    LOADING: number
    DONE: number
    readyState: number
    responseText: string
    responseXML: string
    status: number
    statusText: {
      code: string
    }
  }
  type: string
}

/**
 * WebSocket to handle from-backend communication
 *
 * @param bot - The telegram bot instance
 */
export class WebSocketClient extends Module<ModuleShared, { tgLogger: TgLogger }> {
  private io: TelegramSocket
  private lastErrorCode: string | null = null
  private tokenAuth = new SocketTokenAuth(serviceTokens, { logger })

  constructor() {
    super()
    this.io = io(`http://${env.BACKEND_URL}`, {
      path: WS_PATH,
      // The bot is identified by its token (RFC v3 §8.3).
      auth: this.tokenAuth.auth,
      autoConnect: false,
      parser,
    })
    this.tokenAuth.attach(this.io)
    this.io.on("connect", () => {
      logger.info("[WS] connected")
      this.lastErrorCode = null
    })

    this.io.on("connect_error", (error: Error) => {
      if (WebSocketClient.isSocketError(error)) {
        const code = error.context.statusText.code
        if (this.lastErrorCode === code) return

        if (code === "ECONNREFUSED") logger.error("[WS] server is offline or unreachable")
        else logger.error({ error }, "[WS] error while connecting")

        this.lastErrorCode = code
        return
      }

      logger.error({ error }, "[WS] UNKNOWN error while connecting")
    })

    this.io.on("disconnect", (reason, details) => {
      logger.info({ reason, details }, "[WS] disconnected")
    })

    this.io.on("ban", async ({ chatId, userId, durationInSeconds }, cb) => {
      const error = await this.shared.api
        .banChatMember(chatId, userId, {
          until_date: durationInSeconds ? duration.zod.parse(`${durationInSeconds}s`).timestamp_s : undefined,
        })
        .then(() => null)
        .catch((e) => JSON.stringify(e))

      if (error) {
        logger.error({ error }, "[WS] Telegram API ban call failed")
        cb(error)
      } else {
        logger.debug("[WS] Telegram API ban call OK")
        cb(null)
      }
    })

    this.io.on("logGrantCreate", async (data, cb) => {
      const { userId, validSince, validUntil, reason } = data
      const target = await MessageUserStorage.getInstance().getStoredUser(userId)
      const admin = await grantActor(data)
      if (!target || !admin) {
        logger.error("[WS] grant create log ERROR -- cannot retrieve users")
        cb("Cannot retrieve the users")
        return
      }

      const res = await this.getModule("tgLogger")
        .grants({
          action: "CREATE",
          target: target,
          by: admin,
          since: validSince,
          until: validUntil,
          reason,
        })
        .catch(() => null)

      if (!res) {
        logger.error("[WS] grant create log ERROR -- cannot send log")
        cb("Cannot send the log")
        return
      }

      logger.debug("[WS] grant create log OK")
      cb(null)
    })

    this.io.on("logGrantInterrupt", async (data, cb) => {
      const target = await MessageUserStorage.getInstance().getStoredUser(data.userId)
      const admin = await grantActor(data)
      if (!target || !admin) {
        logger.error("[WS] grant interrupt log ERROR -- cannot retrieve users")
        cb("Cannot retrieve the users")
        return
      }

      const res = await this.getModule("tgLogger")
        .grants({
          action: "INTERRUPT",
          target: target,
          by: admin,
        })
        .catch(() => null)

      if (!res) {
        logger.error("[WS] grant interrupt log ERROR -- cannot send log")
        cb("Cannot send the log")
        return
      }

      logger.debug("[WS] grant interrupt log OK")
      cb(null)
    })

    this.io.on(
      "leaveChat",
      async (data: { chatId: number; performerId: number | null; performer?: SocketActor }, cb) => {
        const { chatId, performer } = data
        const ok = await this.shared.api.leaveChat(chatId).catch(() => false)

        const performedBy = performer
          ? { performerTelegramId: performer.telegramId, performerSub: performer.sub }
          : { performerTelegramId: data.performerId }
        if (ok) logger.info({ chatId, ...performedBy }, "[WS] leave chat performed")
        cb(ok)
      }
    )
  }

  override async start() {
    this.io.connect()
  }

  override async stop() {
    this.tokenAuth.stop()
    this.io.disconnect()
  }

  static isSocketError(e: Error): e is SocketError {
    if ("context" in e) return true
    return false
  }
}
