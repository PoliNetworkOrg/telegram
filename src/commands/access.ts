import { type AccessEntry, authorizeAction, DENIED, type Decision, type Permission, resolveOne } from "@/access"
import { backendFor } from "@/backend"
import { type Authorize, ManagedCommands } from "@/lib/managed-commands"
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

/**
 * The sender's IdP access, looked up once per update: `/help` and the commands menu decide on every command at once.
 * A failed lookup is shared too, and denies every command of the update.
 */
const senderAccess = new WeakMap<object, Promise<AccessEntry>>()

/**
 * Whether the sender of an update may run a command. ManagedCommands also uses it to build `/help` and the commands
 * menu, so it must take group admin status only from `isGroupAdmin`, see {@link Authorize}.
 */
export const authorizeCommand: Authorize<Context, CommandAccess> = async ({ context, command, isGroupAdmin }) => {
  const { permissions } = command
  if (!permissions?.requiredPermissions?.length) return { allowed: true, basis: null }
  const from = context.from
  if (!from) return DENIED

  const backend = backendFor(from)
  return authorizeAction({
    check: `command:/${ManagedCommands.commandID(command)}`,
    actorId: from.id,
    chatId: context.chat.id,
    backend,
    required: permissions.requiredPermissions,
    actor: () => {
      let access = senderAccess.get(context)
      if (!access) {
        access = resolveOne(backend, from.id)
        senderAccess.set(context, access)
      }
      return access
    },
    // false outside of groups, so the shortcut only ever applies in groups
    isChatAdmin: permissions.allowTelegramChatAdmins ? isGroupAdmin : undefined,
  })
}
