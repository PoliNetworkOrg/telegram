import type { ConversationData, VersionedState } from "@grammyjs/conversations"
import { api } from "@/backend"
import { isAllowedInGroups, ManagedCommands } from "@/lib/managed-commands"
import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { redis } from "@/redis"
import type { Role } from "@/utils/types"
import { printCtxFrom } from "@/utils/users"
import { wait } from "@/utils/wait"
import { audit } from "./audit"
import { ban } from "./ban"
import { banAll } from "./banall"
import { del } from "./del"
import { grants } from "./grants"
import { kick } from "./kick"
import { linkAdminDashboard } from "./link-admin-dashboard"
import { mute } from "./mute"
import { report } from "./report"
import { role } from "./role"
import { search } from "./search"
import { userid } from "./userid"

const adapter = new RedisFallbackAdapter<VersionedState<ConversationData>>({
  redis,
  prefix: "conv",
  logger,
})

export const commands = new ManagedCommands<Role>({
  adapter,
  hooks: {
    wrongScope: async ({ context, command }) => {
      await context.deleteMessage()
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
      const reply = await context.reply("You are not allowed to execute this command")
      await context.deleteMessage()
      void wait(3000).then(() => reply.delete())
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
  },
  permissionHandler: async ({ command, context: ctx }) => {
    if (!command.permissions) return true
    if (!ctx.from) return false

    const { allowedRoles, excludedRoles } = command.permissions

    if (isAllowedInGroups(command)) {
      const { allowedGroupAdmins, allowedGroupsId, excludedGroupsId } = command.permissions
      const { status: groupRole } = await ctx.getChatMember(ctx.from.id)

      if (allowedGroupsId && !allowedGroupsId.includes(ctx.chatId)) return false
      if (excludedGroupsId?.includes(ctx.chatId)) return false
      if (allowedGroupAdmins) {
        const isDbAdmin = await api.tg.permissions.checkGroup.query({ userId: ctx.from.id, groupId: ctx.chatId })
        const isTgAdmin = groupRole === "administrator" || groupRole === "creator"
        if (isDbAdmin || isTgAdmin) return true
      }
    }

    const { roles } = await api.tg.permissions.getRoles.query({ userId: ctx.from.id })
    if (!roles) return false

    // blacklist is stronger than whitelist
    if (allowedRoles?.every((r) => !roles.includes(r))) return false
    if (excludedRoles?.some((r) => roles.includes(r))) return false

    return true
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
  .withCollection(audit, ban, banAll, del, grants, kick, linkAdminDashboard, mute, report, role, search, userid)
