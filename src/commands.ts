import type { ConversationData, VersionedState } from "@grammyjs/conversations"
import { api, type Role } from "./backend"
import { isAllowedInGroups, ManagedCommands } from "./lib/managed-commands"
import { RedisAdapter } from "./redis/storage-adapter"
import { logger } from "./logger"
import { getTelegramId } from "./utils/telegram-id"
import { getText, sanitizeText } from "./utils/messages"

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
