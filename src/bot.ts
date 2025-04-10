import { Context } from "@/lib/managed-commands"
import { logger } from "./logger"
import { setTelegramId } from "./utils/telegram-id"
import { redis } from "./redis"
import { apiTestQuery } from "./backend"
import { Bot } from "grammy"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import { hydrate } from "@grammyjs/hydrate"
import { commands } from "./commands"

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

bot.start({ onStart: () => logger.info("Bot started!") })

async function terminate(signal: NodeJS.Signals) {
  logger.warn(`Received ${signal}, shutting down...`)
  await bot.stop()
  logger.info("Bot stopped!")
  await redis.quit()
  logger.info("Redis connection closed!")
  process.exit(0)
}
process.on("SIGINT", terminate)
process.on("SIGTERM", terminate)
