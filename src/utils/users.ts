import type { Context } from "grammy"
import type { User } from "grammy/types"
import { logger } from "@/logger"
import { MessageUserStorage } from "@/middlewares/message-user-storage"
import { getTelegramId } from "./telegram-id"

export async function getUser<C extends Context>(userId: number, ctx: C | null): Promise<User | null> {
  // TODO: check if this works correctly
  const chatUser = ctx ? await ctx.getChatMember(userId).catch(() => null) : null
  return chatUser?.user ?? MessageUserStorage.getInstance().getStoredUser(userId)
}

export async function getUserFromIdOrUsername<C extends Context>(
  idOrUsername: number | string,
  ctx: C | null
): Promise<User | null> {
  const userId = typeof idOrUsername === "string" ? await getTelegramId(idOrUsername.replaceAll("@", "")) : idOrUsername
  if (!userId) {
    logger.debug(`unmute: no userId for username ${idOrUsername}`)
    return null
  }

  return await getUser(userId, ctx)
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
