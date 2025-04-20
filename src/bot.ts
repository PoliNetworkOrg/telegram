import { Context } from "@/lib/managed-commands"
import { logger } from "./logger"
import { setTelegramId } from "./utils/telegram-id"
import { redis } from "./redis"
import { apiTestQuery } from "./backend"
import { Bot } from "grammy"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import { hydrate } from "@grammyjs/hydrate"
import { commands } from "./commands"
import { messageStorage } from "./middlewares/message-storage"
import { messageLink } from "./middlewares/message-link"

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN environment variable is required!")
}

await apiTestQuery()

const bot = new Bot<Context>(process.env.BOT_TOKEN)
bot.use(hydrate())
bot.use(hydrateReply)

bot.api.config.use(parseMode("MarkdownV2"))
bot.use(commands)

bot.on("message", async (ctx, next) => {
  const { username, id } = ctx.message.from
  if (username) setTelegramId(username, id)

  await next()
})

bot.on("message", messageLink({ channelIds: [-1002669533277] })) // now is configured a test group
bot.on("message", messageStorage)

bot.start({ onStart: () => logger.info("Bot started!") })

async function terminate(signal: NodeJS.Signals) {
  logger.warn(`Received ${signal}, shutting down...`)
  await redis.quit() // close event logged in redis file
  await bot.stop()
  logger.info("Bot stopped!")
  process.exit(0)
}
process.on("SIGINT", terminate)
process.on("SIGTERM", terminate)
