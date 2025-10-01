import type { ConversationData, VersionedState } from "@grammyjs/conversations"

import { api } from "@/backend"
import { isAllowedInGroups, ManagedCommands } from "@/lib/managed-commands"
import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { redis } from "@/redis"
import type { Role } from "@/utils/types"

const adapter = new RedisFallbackAdapter<VersionedState<ConversationData>>({
  redis,
  prefix: "conv",
  logger,
})

export const _commandsBase = new ManagedCommands<Role>({
  adapter,
  logger,
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
}).createCommand({
  trigger: "ping",
  scope: "private",
  description: "Replies with pong",
  handler: async ({ context }) => {
    await context.reply("pong")
  },
})
