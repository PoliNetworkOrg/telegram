import { type TelegramSocket, WS_PATH } from "@polinetwork/backend"
import * as parser from "@socket.io/devalue-parser"
import { io } from "socket.io-client"
import { env } from "@/env"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { MessageUserStorage } from "@/middlewares/message-user-storage"
import { duration } from "@/utils/duration"
import type { ModuleShared } from "@/utils/types"
import type { TgLogger } from "./tg-logger"

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

  constructor() {
    super()
    this.io = io(`http://${env.BACKEND_URL}`, {
      path: WS_PATH,
      query: { type: "telegram" },
      autoConnect: false,
      parser,
    })
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

    this.io.on("logGrantCreate", async ({ userId, adminId, validSince, validUntil, reason }, cb) => {
      const target = await MessageUserStorage.getInstance().getStoredUser(userId)
      const admin = await MessageUserStorage.getInstance().getStoredUser(adminId)
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

    this.io.on("logGrantInterrupt", async ({ userId, adminId }, cb) => {
      const target = await MessageUserStorage.getInstance().getStoredUser(userId)
      const admin = await MessageUserStorage.getInstance().getStoredUser(adminId)
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

    this.io.on("leaveChat", async ({ chatId, performerId }, cb) => {
      const ok = await this.shared.api.leaveChat(chatId).catch(() => false)

      if (ok) logger.info({ chatId, performerId }, "[WS] leave chat performed")
      cb(ok)
    })
  }

  override async start() {
    this.io.connect()
  }

  override async stop() {
    this.io.disconnect()
  }

  static isSocketError(e: Error): e is SocketError {
    if ("context" in e) return true
    return false
  }
}
