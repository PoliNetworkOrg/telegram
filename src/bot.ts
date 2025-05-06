import { Context } from "@/lib/managed-commands"
import { logger } from "./logger"
import { setTelegramId } from "./utils/telegram-id"
import { redis } from "./redis"
import { apiTestQuery } from "./backend"
import { Bot } from "grammy"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import { hydrate } from "@grammyjs/hydrate"
import { commands } from "./commands"
import { MessageStorage } from "./middlewares/message-storage"
import { messageLink } from "./middlewares/message-link"
import { env } from "./env"

await apiTestQuery()
export const messageStorage = new MessageStorage()

const bot = new Bot<Context>(env.BOT_TOKEN)
bot.use(hydrate())
bot.use(hydrateReply)

bot.api.config.use(parseMode("MarkdownV2"))
bot.use(commands)

bot.on("message", async (ctx, next) => {
  const { username, id } = ctx.message.from
  if (username) void setTelegramId(username, id)

  await next()
})

bot.on("message", messageLink({ channelIds: [-1002669533277] })) // now is configured a test group
bot.on("message", messageStorage.middleware)

void bot.start({
  onStart: () => {
    logger.info("Bot started!")
  },
})

let terminateStarted = false // this ensure that it's called only once. otherwise strange behaviours
async function terminate(signal: NodeJS.Signals) {
  if (terminateStarted) return

  terminateStarted = true
  logger.warn(`Received ${signal}, shutting down...`)
  const p1 = messageStorage.sync()
  const p2 = redis.quit()
  const p3 = bot.stop()
  await Promise.all([p1, p2, p3])
  logger.info("Bot stopped!")
  process.exit(0)
}
process.on("SIGINT", () => void terminate("SIGINT"))
process.on("SIGTERM", () => void terminate("SIGTERM"))
