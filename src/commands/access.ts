import { authorizeAction, DENIED, type Decision, type Permission } from "@/access"
import { backendFor } from "@/backend"
import { type Authorize, ManagedCommands, type PermissionCheck } from "@/lib/managed-commands"
import { isFromGroupChat } from "@/utils/chat"
import type { Context, Role } from "@/utils/types"

/** How commands declare IdP permissions next to the legacy roles, and what their handlers receive. */
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

/**
 * The legacy role check as a decision. A pass through the group admin shortcut is reported as
 * `telegram_chat_admin`, a pass through a listed role as `idp_permission` (the permission path).
 */
function legacyDecision(check: PermissionCheck): Decision {
  if (!check.allowed) return DENIED
  switch (check.via) {
    case "group_admin":
      return { allowed: true, basis: "telegram_chat_admin" }
    case "role":
      return { allowed: true, basis: "idp_permission" }
    case "unrestricted":
      return { allowed: true, basis: null }
  }
}

export const authorizeCommand: Authorize<Context, Role, CommandAccess> = async ({ context, command, check }) => {
  const legacy = async () => legacyDecision(await check())
  const { permissions } = command
  // Commands without IdP permissions (/addrole, /delrole) keep the legacy check until they are removed (RFC v3 §10.4).
  if (!permissions?.requiredPermissions || !context.from) return legacy()
  const from = context.from

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
    legacy,
  })
}
