import { authorizeAction, DENIED, type Decision, type Permission } from "@/access"
import { backendFor } from "@/backend"
import { type Authorize, ManagedCommands } from "@/lib/managed-commands"
import { isFromGroupChat } from "@/utils/chat"
import type { Context } from "@/utils/types"

/** How commands declare IdP permissions, and what their handlers receive. */
export type CommandAccess = {
  permissions: {
    /** The IdP permissions the user must all hold (RFC v3 §10.2) */
    requiredPermissions?: readonly Permission[]
    /**
     * Whether native admins of the chat (Telegram status "administrator" or "creator") may use the
     * command in groups without the required permissions (RFC v3 §4 decision 2)
     */
    allowTelegramChatAdmins?: boolean
  }
  /** Why the user was allowed to run the command; its `basis` is what moderation actions record in the audit log. */
  authorization: Decision
}

export const authorizeCommand: Authorize<Context, string, CommandAccess> = async ({ context, command }) => {
  const { permissions } = command
  if (!permissions?.requiredPermissions?.length) return { allowed: true, basis: null }
  const from = context.from
  if (!from) return DENIED

  return authorizeAction({
    check: `command:/${ManagedCommands.commandID(command)}`,
    actorId: from.id,
    chatId: context.chat.id,
    backend: backendFor(from),
    required: permissions.requiredPermissions,
    isChatAdmin:
      permissions.allowTelegramChatAdmins && isFromGroupChat(context)
        ? async () => {
            const { status } = await context.getChatMember(from.id)
            return status === "administrator" || status === "creator"
          }
        : undefined,
  })
}
