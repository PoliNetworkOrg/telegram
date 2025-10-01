import { type TelegramSocket, WS_PATH } from "@polinetwork/backend"
import { io } from "socket.io-client"
import { env } from "./env"
import { Module } from "./lib/modules"
import { logger } from "./logger"
import { duration } from "./utils/duration"
import type { ModuleShared } from "./utils/types"

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
export class WebSocketClient extends Module<ModuleShared> {
  private io: TelegramSocket
  private lastErrorCode: string | null = null

  constructor() {
    super()
    this.io = io(`http://${env.BACKEND_URL}`, { path: WS_PATH, query: { type: "telegram" } })
  }
  override async start() {
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
  }

  override async stop() {
    this.io.close()
    logger.info("[WS] disconnected")
  }

  static isSocketError(e: Error): e is SocketError {
    if ("context" in e) return true
    return false
  }
}
