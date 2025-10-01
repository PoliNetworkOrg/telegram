import { type TelegramSocket, WS_PATH } from "@polinetwork/backend"
import { io } from "socket.io-client"
import { env } from "./env"
import { Module } from "./lib/modules"
import { logger } from "./logger"
import { duration } from "./utils/duration"
import type { ModuleShared } from "./utils/types"

/**
 * WebSocket to handle from-backend communication
 *
 * @param bot - The telegram bot instance
 */
export class WebSocketClient extends Module<ModuleShared> {
  private io: TelegramSocket

  constructor() {
    super()

    this.io = io(`http://${env.BACKEND_URL}`, { path: WS_PATH, query: { type: "telegram" } })
    this.io.on("connect", () => logger.info("[WS] connected"))
    this.io.on("connect_error", (error) => logger.info({ error }, "[WS] error while connecting"))

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
}
