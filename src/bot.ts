import { autoRetry } from "@grammyjs/auto-retry"
import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import { run, sequentialize } from "@grammyjs/runner"
import { Bot, GrammyError, HttpError } from "grammy"
import type { Update } from "grammy/types"
import { apiTestQuery } from "./backend"
import { commands } from "./commands"
import { env } from "./env"
import { MenuGenerator } from "./lib/menu"
import { logger } from "./logger"
import { AutoModerationStack } from "./middlewares/auto-moderation-stack"
import { BotMembershipHandler } from "./middlewares/bot-membership-handler"
import { checkUsername } from "./middlewares/check-username"
import { GroupSpecificActions } from "./middlewares/group-specific-actions"
import { messageLink } from "./middlewares/message-link"
import { MessageUserStorage } from "./middlewares/message-user-storage"
import { UIActionsLogger } from "./middlewares/ui-actions-logger"
import { modules, sharedDataInit } from "./modules"
import { redis } from "./redis"
import { once } from "./utils/once"
import { setTelegramId } from "./utils/telegram-id"
import type { Context, ModuleShared } from "./utils/types"

const TEST_CHAT_ID = -1002669533277
const ALLOWED_UPDATES: ReadonlyArray<Exclude<keyof Update, "update_id">> = [
  "message",
  "edited_message",
  "message_reaction",
  "message_reaction_count",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  // "channel_post",
  // "edited_channel_post",
  // "business_connection",
  // "business_message",
  // "edited_business_message",
  // "deleted_business_messages",
  // "shipping_query",
  // "pre_checkout_query",
  // "purchased_paid_media",
  // "chat_join_request",
  // "chat_boost",
  // "removed_chat_boost",
]

await apiTestQuery()

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

bot.init().then(() => {
  const sharedData: ModuleShared = {
    api: bot.api,
    botInfo: bot.botInfo,
  }
  sharedDataInit.resolve(sharedData)
})

const tgLogger = modules.get("tgLogger")

bot.use(MenuGenerator.getInstance())
bot.use(commands)
bot.use(new BotMembershipHandler())
bot.use(new AutoModerationStack())
bot.use(new GroupSpecificActions())
bot.use(new UIActionsLogger())

bot.on("message", async (ctx, next) => {
  const { username, id } = ctx.message.from
  if (username) void setTelegramId(username, id)

  await next()
})

bot.on("message", messageLink({ channelIds: [TEST_CHAT_ID] })) // now is configured a test group
bot.on("message", MessageUserStorage.getInstance())
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

const runner = run(bot, {
  runner: {
    fetch: {
      allowed_updates: ALLOWED_UPDATES,
    },
  },
})

const terminate = once(async (signal: NodeJS.Signals) => {
  logger.warn(`Received ${signal}, shutting down...`)
  const p1 = MessageUserStorage.getInstance().sync()
  const p2 = redis.quit()
  const p3 = runner.isRunning() && runner.stop()
  const p4 = modules.stop()
  await Promise.all([p1, p2, p3, p4])
  logger.info("Bot stopped!")
  process.exit(0)
})

process.on("SIGINT", () => terminate("SIGINT"))
process.on("SIGTERM", () => terminate("SIGTERM"))

process.on("unhandledRejection", (reason: Error, promise) => {
  logger.fatal({ reason, promise }, "UNHANDLED PROMISE REJECTION")
  void tgLogger.exception({ type: "UNHANDLED_PROMISE", error: reason, promise })
})
