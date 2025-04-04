import { Telex } from "@/lib/telex"
import { logger } from "./logger"
import { getTelegramId, setTelegramId } from "./utils/telegram-id"
import { redis } from "./redis"
import { sanitizeText, getText } from "./utils/messages"
import { RedisAdapter } from "./redis/storage-adapter"
import type { ConversationData, VersionedState } from "@grammyjs/conversations"
import { api, apiTestQuery } from "./backend"

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN environment variable is required!")
}

await apiTestQuery()

const convStorageAdapter = new RedisAdapter<VersionedState<ConversationData>>("conv")

const bot = new Telex(process.env.BOT_TOKEN)
  .setup(convStorageAdapter)
  .createCommand({
    trigger: "name",
    description: "Quick conversation",
    handler: async ({ conversation, context }) => {
      const question = await context.reply("What is your name?")
      const { message } = await conversation.waitFor("message:text")
      await context.deleteMessage()
      await message.delete()
      await question.delete()
      await context.reply(`Hello, ${message.text}\\!`)
    },
  })
  .createCommand({
    trigger: "ping",
    description: "Replies with pong",
    handler: async ({ context }) => {
      await context.reply("pong")
    },
  })
  .createCommand({
    trigger: "testdb",
    description: "Test postgres db through the backend",
    handler: async ({ context }) => {
      try {
        const res = await api.test.dbQuery.query({ dbName: "tg" })
        const str = res.map((r) => sanitizeText("- " + r)).join("\n")
        await context.reply(
          res.length > 0 ? "Elements inside `tg_test` table: \n" + str : "No elements inside `tg_test` table"
        )
      } catch (err) {
        await context.reply("There was an error: \n" + err)
      }
    },
  })
  .createCommand({
    trigger: "testargs",
    description: "Test args",
    args: [
      { key: "arg1", description: "first arg" },
      { key: "arg2", description: "second arg", optional: false },
      { key: "arg3", description: "the optional one", optional: true },
    ],
    handler: async ({ context, args }) => {
      console.log(args)
      await context.reply("pong")
    },
  })
  .createCommand({
    trigger: "del",
    description: "Deletes the replied to message",
    reply: "required",
    handler: async ({ repliedTo, context }) => {
      const { text, type } = getText(repliedTo)
      logger.info({
        action: "delete_message",
        messageText: text ?? "[non-textual]",
        messageType: type,
        sender: repliedTo.from?.username,
      })
      await context.deleteMessages([repliedTo.message_id])
      await context.deleteMessage()
    },
  })
  .createCommand({
    trigger: "userid",
    description: "Gets the ID of a username",
    args: [{ key: "username", description: "The username to get the ID of" }],
    handler: async ({ context, args }) => {
      const username = args.username.replace("@", "")
      const id = await getTelegramId(username)
      if (!id) {
        logger.warn(`[userid] username @${username} not in our cache`)
        await context.reply(`Username @${username} not in our cache`)
        return
      }

      await context.reply(`Username \`@${username}\`\nid: \`${id}\``)
    },
  })
  .onStop(async (reason) => {
    logger.info(reason ? `Bot Stopped. Reason: ${reason}` : "Bot Stopped")
    await redis.quit()
  })

bot.on("message", async (ctx, next) => {
  const { username, id } = ctx.message.from
  if (username) setTelegramId(username, id)

  await next()
})

bot.start({ onStart: () => logger.info("Bot started!") })
