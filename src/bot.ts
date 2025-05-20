import type { Context } from "@/lib/managed-commands"

import { autoRetry } from "@grammyjs/auto-retry"
import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import { run, sequentialize } from "@grammyjs/runner"
import { Bot, GrammyError, HttpError } from "grammy"

import { apiTestQuery } from "./backend"
import { commands } from "./commands"
import { env } from "./env"
import { logger } from "./logger"
import { botJoin } from "./middlewares/bot-join"
import { checkUsername } from "./middlewares/check-username"
import { messageLink } from "./middlewares/message-link"
import { MessageStorage } from "./middlewares/message-storage"
import { redis } from "./redis"
import { fmt } from "./utils/format"
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
bot.use(commands)

bot.on("message", async (ctx, next) => {
  const { username, id } = ctx.message.from
  if (username) void setTelegramId(username, id)

  await next()
})

bot.on("message", messageLink({ channelIds: [TEST_CHAT_ID] })) // now is configured a test group
bot.on("message", messageStorage.middleware)
bot.on("my_chat_member", botJoin({ logChatId: TEST_CHAT_ID }))
bot.on("message", checkUsername)

bot.catch(async (err) => {
  const { error } = err
  const msg = fmt(
    ({ b, code, n, i, codeblock, u, link }) => {
      const lines = [n`⚠️ An error occured inside the middleware stack`, b`${u`${err.message}`}\n`]
      if (error instanceof GrammyError) {
        lines.push(
          n`${u`${b`grammY Error`} while calling method`}: ${link(
            error.method,
            `https://core.telegram.org/bots/api#${error.method.toLowerCase()}`
          )} (${code`${error.error_code}`})`
        )
        lines.push(n`Description: ${i`${error.description}`}`)
        lines.push(n`Payload:`, codeblock`${JSON.stringify(error.payload, null, 2)}`)
      } else if (error instanceof HttpError) {
        lines.push(n`${u`HTTP Error`}: ${code`${error.name}`}`)
      } else if (error instanceof Error) {
        lines.push(n`Unknown Error: ${code`${error.name}`}`)
      } else {
        lines.push(n`Something besides an ${code`Error`} has been thrown, check the logs for more info`)
      }
      return lines
    },
    { sep: "\n" }
  )

  const e = err as { ctx: { api?: unknown } }
  delete e.ctx.api // LEAKS API TOKEN IN LOGS!!
  logger.error(e)
  await bot.api.sendMessage(TEST_CHAT_ID, msg).catch(() => {
    logger.error("Couldn't send the middleware stack error through the bot")
  })
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
  logger.fatal("UNHANDLED PROMISE REJECTION")
  logger.fatal(reason)
  logger.fatal(promise)
  void bot.api
    .sendMessage(
      TEST_CHAT_ID,
      fmt(
        ({ b, u, n, i, codeblock }) => [
          b`${u`🛑 UNHANDLED PROMISE REJECTION`}`,
          n`${reason.name}`,
          i`${reason.message}`,
          codeblock`${reason.stack ?? `no stack trace available`}`,
        ],
        {
          sep: "\n",
        }
      )
    )
    .catch(() => {
      logger.fatal("Couldn't send the 'unhandled rejection' error message through the bot, how ironic ")
    })
})
