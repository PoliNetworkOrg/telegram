import type { ConversationData, VersionedState } from "@grammyjs/conversations"
import { api, type Role } from "./backend"
import { isAllowedInGroups, ManagedCommands } from "./lib/managed-commands"
import { RedisAdapter } from "./redis/storage-adapter"
import { logger } from "./logger"
import { getTelegramId } from "./utils/telegram-id"
import { getText } from "./utils/messages"
import { fmt } from "./utils/format"

const convStorageAdapter = new RedisAdapter<VersionedState<ConversationData>>("conv")

export const commands = new ManagedCommands<Role>({
  adapter: (await convStorageAdapter.ready()) ? convStorageAdapter : undefined,
  logger,
  permissionHandler: async ({ command, context: ctx }) => {
    if (!command.permissions) return true
    if (!ctx.from) return false

    const { allowedRoles, excludedRoles } = command.permissions

    if (isAllowedInGroups(command)) {
      const { allowedGroupAdmins, allowedGroupsId, excludedGroupsId } = command.permissions
      const { status: groupRole } = await ctx.getChatMember(ctx.from.id)

      if (allowedGroupsId && !allowedGroupsId.includes(ctx.chatId)) return false
      if (excludedGroupsId && excludedGroupsId.includes(ctx.chatId)) return false
      if (allowedGroupAdmins) {
        const isDbAdmin = await api.tg.permissions.checkGroup.query({ userId: ctx.from.id, groupId: ctx.chatId })
        const isTgAdmin = groupRole === "administrator" || groupRole === "creator"
        if (isDbAdmin || isTgAdmin) return true
      }
    }

    const { role } = await api.tg.permissions.getRole.query({ userId: ctx.from.id })
    const userRole = role as Role
    if (allowedRoles && !allowedRoles.includes(userRole)) return false
    if (excludedRoles && excludedRoles.includes(userRole)) return false

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
      await context.reply(fmt(() => `Hello, ${message.text}!`))
    },
  })
  .createCommand({
    trigger: "format",
    scope: "private",
    description: "Test the formatting",
    handler: async ({ context }) => {
      const response = fmt(({ n, b, i, u, code, codeblock, link, strikethrough, spoiler }) => [
        `This is a message to`,
        b`test formatting`,
        `with`,
        i`multiple examples`,
        `like`,
        b`${u`concatened`}`,
        b`${u`multiple ${i`concatened`}`}`,
        `(also`,
        b`${i`concatened ${u`multiple`}`}`,
        `) and`,
        link(b`incredible links`, "https://polinetwork.org"),
        `and`,
        code`codeblocks`,
        codeblock`const assoc = 'polinetwork'`,
        `and other strange formatters:`,
        strikethrough`striked`,
        spoiler`spoiler`,
        n`(also normal with ${b`bold`})`,
      ])
      await context.reply(response)
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
        await context.reply(fmt(({ b }) => [`Role:`, b`${role}`]))
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
        await context.reply(
          fmt(({ code }) =>
            res.length > 0
              ? [`Elements inside`, code`tg_test`, `table:`, ...res.map((r) => `\n- ${r}`)]
              : [`No elements inside`, code`tg_test`, `table`]
          )
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
      if (!id) {
        logger.warn(`[/userid] username @${username} not in our cache`)
        await context.reply(fmt(() => `Username @${username} not in our cache`))
        return
      }

      await context.reply(fmt(({ code }) => [`Username: @${username}`, `\nid:`, code`${id}`]))
    },
  })
  .createCommand({
    trigger: "link",
    scope: "private",
    description: "Verify the login code for the admin dashboard",
    args: [{ key: "code", description: "The code to verify" }],
    handler: async ({ context, args }) => {
      const { code } = args
      if (context.from === undefined) return
      if (context.from.username === undefined) {
        await context.reply(fmt(() => `You need to set a username to use this command`))
        return
      }
      const res = await api.tg.link.link.query({
        code,
        telegramId: context.from.id,
        telegramUsername: context.from.username,
      })
      if ("error" in res) {
        logger.error(res.error)
        await context.reply(fmt(() => `Invalid code or your username does not match.`))
        return
      }

      if (res.success) {
        await context.reply(
          fmt(({ b }) => [b`Code verified!`, `This telegram account is now linked in the admin dashboard.`], {
            sep: "\n",
          })
        )
      }
    },
  })
