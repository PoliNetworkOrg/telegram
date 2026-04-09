import type { ConversationData, VersionedState } from "@grammyjs/conversations"
import { Point } from "@influxdata/influxdb-client"
import { api } from "@/backend"
import { type CommandScopedContext, ManagedCommands } from "@/lib/managed-commands"
import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { modules } from "@/modules"
import type { TelemetryContextFlavor } from "@/modules/telemetry"
import { redis } from "@/redis"
import { ephemeral } from "@/utils/messages"
import type { Context, Role } from "@/utils/types"
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

export const commands = new ManagedCommands<Role, Context, TelemetryContextFlavor<CommandScopedContext>>({
  adapter,
  plugins: [
    (ctx, next) => {
      ctx.point = new Point("command_execution")
      return next()
    },
  ],
  hooks: {
    wrongScope: async ({ context, command }) => {
      await context.deleteMessage().catch(() => {})
      logger.info(
        `[ManagedCommands] Command '/${command.trigger}' with scope '${command.scope}' invoked by ${printCtxFrom(context)} in a '${context.chat.type}' chat`
      )
    },
    missingPermissions: async ({ context, command }) => {
      await context.deleteMessage().catch(() => {})
      logger.info(
        { command_permissions: command.permissions },
        `[ManagedCommands] Command '/${command.trigger}' invoked by ${printCtxFrom(context)} without permissions`
      )
      // Inform the user of restricted access
      void ephemeral(context.reply("You are not allowed to execute this command"))
    },
    conversationBegin: async ({ context, command, conversation }) => {
      const now = await conversation.now()
      context.point
        .tag("command", ManagedCommands.commandID(command))
        .tag("chat_type", context.chat.type)
        .tag("invoked_by", context.from.id.toString(10))
        .tag("invoked_from", context.chat.id.toString(10))
        .timestamp(new Date(now))
      context.stackTimes = { managedCommands: now }
      if (context.chat.type !== "private") {
        // silently delete the command trigger if the command is used in a group, to reduce noise
        await context.deleteMessage().catch(() => {})
      }
    },
    handlerError: async ({ context, command, error }) => {
      context.point.tag("error", String(error))
      logger.error({ error }, `[ManagedCommands] Error in handler for command '/${command.trigger}'`)
      await modules
        .get("tgLogger")
        .exception({ type: "UNKNOWN", error }, "managedCommands.handlerError() -- command handler")
        .catch(() => {})
      // TODO: we should figure out what to tell the user, maybe if we have some telemetry we can produce an error report id here?
      await context.reply(`An error occurred: ${String(error)}`).catch(() => {})
    },
    conversationEnd: async ({ context, command, conversation }) => {
      logger.debug(
        `[ManagedCommands] ${ManagedCommands.commandID(command)} execution finished for ${printCtxFrom(context)}}`
      )
      context.point.intField("duration", (await conversation.now()) - context.stackTimes.managedCommands)
      modules.get("influx").writePoint(context.point)
    },
    overrideGroupAdminCheck: async (userId, groupId, ctx) => {
      const { status: groupRole } = await ctx.getChatMember(userId)
      if (groupRole === "administrator" || groupRole === "creator") return true
      const isDbAdmin = await api.tg.permissions.checkGroup.query({ userId, groupId })
      return isDbAdmin
    },
    commandMiddlewareStart: async ({ context, command }) => {
      context.stackTimes = { managedCommands: Date.now() }
      context.point.tag("command", ManagedCommands.commandID(command)).tag("chat_type", context.chat.type)
    },
    commandMiddlewareEnd: async ({ context, command }) => {
      logger.debug(`[ManagedCommands] Command '/${command.trigger}' invoked by ${printCtxFrom(context)}`)
      context.point.intField("managed_commands_duration", Date.now() - context.stackTimes.managedCommands)
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
