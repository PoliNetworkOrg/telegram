import type { ConversationData, VersionedState } from "@grammyjs/conversations"

import { type Role, api } from "@/backend"
import { ManagedCommands, isAllowedInGroups } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { RedisAdapter } from "@/redis/storage-adapter"

const convStorageAdapter = new RedisAdapter<VersionedState<ConversationData>>("conv")

export const _commandsBase = new ManagedCommands<Role>({
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
    if (role === "user") return false // TODO: maybe we should do this differently

    const userRole = role as Role
    if (allowedRoles && !allowedRoles.includes(userRole)) return false
    if (excludedRoles && excludedRoles.includes(userRole)) return false

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
