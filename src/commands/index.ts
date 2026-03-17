import type { ConversationData, VersionedState } from "@grammyjs/conversations"
import { api } from "@/backend"
import { ManagedCommands } from "@/lib/managed-commands"
import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { redis } from "@/redis"
import { ephemeral } from "@/utils/messages"
import type { Role } from "@/utils/types"
import { printCtxFrom } from "@/utils/users"
import { linkAdminDashboard } from "./link-admin-dashboard"
import { management } from "./management"
import { moderation } from "./moderation"
import { report } from "./report"
import { search } from "./search"

const adapter = new RedisFallbackAdapter<VersionedState<ConversationData>>({
  redis,
  prefix: "conv",
  logger,
})

export const commands = new ManagedCommands<Role>({
  adapter,
  hooks: {
    wrongScope: async ({ context, command }) => {
      await context.deleteMessage().catch(() => {})
      logger.info(
        `[ManagedCommands] Command '/${command.trigger}' with scope '${command.scope}' invoked by ${printCtxFrom(context)} in a '${context.chat.type}' chat`
      )
    },
    missingPermissions: async ({ context, command }) => {
      logger.info(
        { command_permissions: command.permissions },
        `[ManagedCommands] Command '/${command.trigger}' invoked by ${printCtxFrom(context)} without permissions`
      )
      // Inform the user of restricted access
      void ephemeral(context.reply("You are not allowed to execute this command"))
      await context.deleteMessage()
    },
    handlerError: async ({ context, command, error }) => {
      logger.error({ error }, `[ManagedCommands] Error in handler for command '/${command.trigger}'`)
      // TODO: we should figure out what to tell the user, maybe if we have some telemetry we can produce an error report id here?
      await context.reply(`An error occurred: ${String(error)}`)
    },
    beforeHandler: async ({ context }) => {
      if (context.chat.type !== "private") {
        // silently delete the command trigger if the command is used in a group, to reduce noise
        context.deleteMessage().catch(() => {})
      }
    },
    overrideGroupAdminCheck: async (userId, groupId, ctx) => {
      const { status: groupRole } = await ctx.getChatMember(userId)
      if (groupRole === "administrator" || groupRole === "creator") return true
      const isDbAdmin = await api.tg.permissions.checkGroup.query({ userId, groupId })
      return isDbAdmin
    },
  },
  getUserRoles: async (userId) => {
    // TODO: cache this to avoid hitting the db on every command
    const { roles } = await api.tg.permissions.getRoles.query({ userId })
    return roles || []
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
  .withCollection(linkAdminDashboard, report, search, management, moderation)
