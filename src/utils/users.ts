import type { Context } from "grammy"
import type { User } from "grammy/types"
import { MessageUserStorage } from "@/middlewares/message-user-storage"

export async function getUser<C extends Context>(userId: number, ctx: C | null): Promise<User | null> {
  // TODO: check if this works correctly
  const chatUser = ctx ? await ctx.getChatMember(userId).catch(() => null) : null
  return chatUser?.user ?? MessageUserStorage.getInstance().getStoredUser(userId)
}

/**
 * Formats a user's username and ID for logging.
 * @param user grammY User object
 * @returns formatted username (if available) and user_id
 */
export function printUsername(user: User): string {
  return `@${user.username ?? "<unset>"} [${user.id}]`
}

/**
 * Formats the context's `from` user information for logging.
 * @param ctx grammY Context object
 * @returns formatted username and user_id of the context's `from` user, or "<N/A>" if not available
 */
export function printCtxFrom<C extends Context = Context>(ctx: C): string {
  if (!ctx.from) return "<N/A>"
  return printUsername(ctx.from)
}
