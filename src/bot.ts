import { isAllowedInGroups, isAllowedInPrivateOnly, ManagedCommands, Context } from "@/lib/managed-commands"
import { logger } from "./logger"
import { getTelegramId, setTelegramId } from "./utils/telegram-id"
import { redis } from "./redis"
import { sanitizeText, getText } from "./utils/messages"
import { RedisAdapter } from "./redis/storage-adapter"
import type { ConversationData, VersionedState } from "@grammyjs/conversations"
import { api, apiTestQuery, Role } from "./backend"
import { Bot } from "grammy"

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN environment variable is required!")
}

await apiTestQuery()

const convStorageAdapter = new RedisAdapter<VersionedState<ConversationData>>("conv")

const bot = new Bot<Context>(process.env.BOT_TOKEN)

const commands = new ManagedCommands<Role>({
  adapter: (await convStorageAdapter.ready()) ? convStorageAdapter : undefined,
  logger,
  permissionHandler: async ({ command }) => {
    if (isAllowedInGroups(command)) {
      const _ = command.permissions
      //    ^ GroupPermissions | undefined
    }

    if (isAllowedInPrivateOnly(command)) {
      const _ = command.permissions
      //    ^ PrivatePermissions | undefined
    }

    return true
  },
})
  .createCommand({
    trigger: "name",
    scope: "private",
    permissions: {
      allowedRoles: ["admin"],
    },
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
    scope: "private",
    description: "Replies with pong",
    handler: async ({ context }) => {
      await context.reply("pong")
    },
  })
  .createCommand({
    trigger: "getrole",
    scope: "private",
    description: "Get role of userid",
    args: [{ key: "userId" }],
    handler: async ({ context, args }) => {
      let userId: number | null = parseInt(args.userId)
      if (isNaN(userId)) {
        userId = await getTelegramId(args.userId)
      }
      if (userId === null) {
        context.reply("Not a valid userId or username not in our cache")
        return
      }

      try {
        const { role } = await api.tg.permissions.getRole.query({ userId })
        await context.reply(`Role: ${role}`)
      } catch (err) {
        await context.reply("There was an error: \n" + err)
      }
    },
  })
  .createCommand({
    trigger: "testdb",
    scope: "private",
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
    scope: "private",
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
    scope: "group",
    permissions: {
      allowedRoles: ["admin", "owner", "direttivo"],
      allowedGroupAdmins: true,
    },
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
    scope: "private",
    description: "Gets the ID of a username",
    args: [{ key: "username", description: "The username to get the ID of" }],
    handler: async ({ context, args }) => {
      const username = args.username.replace("@", "")
      const id = await getTelegramId(username)
      const sanitized = sanitizeText(username)
      if (!id) {
        logger.warn(`[userid] username @${sanitized} not in our cache`)
        await context.reply(`Username @${sanitized} not in our cache`)
        return
      }

      await context.reply(`Username \`@${sanitized}\`\nid: \`${id}\``)
    },
  })

bot.use(commands.middleware())

bot.on("message", async (ctx, next) => {
  const { username, id } = ctx.message.from
  if (username) setTelegramId(username, id)

  await next()
})

bot.start({ onStart: () => logger.info("Bot started!") }).then(async () => {
  logger.info("Bot Stopped")
  await redis.quit()
})
