import { type TelegramSocket, WS_PATH } from "@polinetwork/backend"
import type { Bot, Context } from "grammy"
import { io } from "socket.io-client"
import { env } from "./env"
import { logger } from "./logger"
import { duration } from "./utils/duration"

/**
 * WebSocket to handle from-backend communication
 *
 * @param bot - The telegram bot instance
 */
export class WebSocketClient<C extends Context> {
  private io: TelegramSocket

  constructor(private bot: Bot<C>) {
    this.io = io(`http://${env.BACKEND_URL}`, { path: WS_PATH, query: { type: "telegram" } })
    this.io.on("connect", () => logger.info("[WS] connected"))
    this.io.on("connect_error", (error) => logger.info({ error }, "[WS] error while connecting"))

    this.io.on("ban", async ({ chatId, userId, durationInSeconds }, onSuccess, onError) => {
      try {
        await this.bot.api.banChatMember(chatId, userId, {
          until_date: durationInSeconds ? duration.zod.parse(`${durationInSeconds}s`).timestamp_s : undefined,
        })
        logger.info("[WS] Telegram API ban call OK")
        onSuccess()
      } catch (error) {
        logger.error({ error }, "[WS] Telegram API ban call failed")
        onError(JSON.stringify(error))
      }
    })
  }
}
