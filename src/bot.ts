import type { Context } from "@/lib/managed-commands"

import { autoRetry } from "@grammyjs/auto-retry"
import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import { run, sequentialize } from "@grammyjs/runner"
import { Bot, GrammyError, HttpError } from "grammy"

import { apiTestQuery } from "./backend"
import { commands } from "./commands"
import { env } from "./env"
import { TgLogger } from "./lib/tg-logger"
import { logger } from "./logger"
import { BotMembershipHandler } from "./middlewares/bot-membership-handler"
import { checkUsername } from "./middlewares/check-username"
import { messageLink } from "./middlewares/message-link"
import { MessageStorage } from "./middlewares/message-storage"
import { redis } from "./redis"
import { setTelegramId } from "./utils/telegram-id"

const TEST_CHAT_ID = -1002669533277

await apiTestQuery()
export const messageStorage = new MessageStorage()

const bot = new Bot<Context>(env.BOT_TOKEN)
bot.use(hydrate())
bot.use(hydrateReply)

bot.api.config.use(autoRetry())
bot.api.config.use(parseMode("MarkdownV2"))
bot.use(
  sequentialize((ctx) => {
    return [ctx.chat?.id, ctx.from?.id].filter((e) => e !== undefined).map((e) => e.toString())
  })
)

export const tgLogger = new TgLogger<Context>(bot, -1002685849173, {
  banAll: 13,
  exceptions: 3,
  autoModeration: 7,
  adminActions: 5,
  actionRequired: 10,
  groupManagement: 33,
})

bot.use(commands)
bot.use(new BotMembershipHandler())

bot.on("message", async (ctx, next) => {
  const { username, id } = ctx.message.from
  if (username) void setTelegramId(username, id)

  await next()
})

bot.on("message", messageLink({ channelIds: [TEST_CHAT_ID] })) // now is configured a test group
bot.on("message", messageStorage.middleware)
bot.on("message", checkUsername)
// bot.on("message", async (ctx, next) => { console.log(ctx.message); return await next() })

bot.catch(async (err) => {
  const { error } = err
  if (error instanceof GrammyError) {
    await tgLogger.exception({ type: "BOT_ERROR", error }, "bot.catch() -- middleware stack")
  } else if (error instanceof HttpError) {
    await tgLogger.exception({ type: "HTTP_ERROR", error }, "bot.catch() -- middleware stack")
  } else if (error instanceof Error) {
    await tgLogger.exception({ type: "GENERIC", error }, "bot.catch() -- middleware stack")
  } else {
    await tgLogger.exception({ type: "UNKNOWN", error }, "bot.catch() -- middleware stack")
  }

  const e = err as { ctx: { api?: unknown } }
  delete e.ctx.api // LEAKS API TOKEN IN LOGS!!
  logger.error(e)
})

const runner = run(bot)

let terminateStarted = false // this ensure that it's called only once. otherwise strange behaviours
async function terminate(signal: NodeJS.Signals) {
  if (terminateStarted) return

  terminateStarted = true
  logger.warn(`Received ${signal}, shutting down...`)
  const p1 = messageStorage.sync()
  const p2 = redis.quit()
  const p3 = runner.isRunning() && runner.stop()
  await Promise.all([p1, p2, p3])
  logger.info("Bot stopped!")
  process.exit(0)
}
process.on("SIGINT", () => void terminate("SIGINT"))
process.on("SIGTERM", () => void terminate("SIGTERM"))

process.on("unhandledRejection", (reason: Error, promise) => {
  logger.fatal({ reason, promise }, "UNHANDLED PROMISE REJECTION")
  void tgLogger.exception({ type: "UNHANDLED_PROMISE", error: reason, promise })
})
