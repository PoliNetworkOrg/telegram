import type { Context } from "grammy"
import type { Message, User } from "grammy/types"
import { Err, Ok, type Result } from "neverthrow"
import { MessageUserStorage } from "@/middlewares/message-user-storage"
import { getTelegramId } from "./telegram-id"

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
 * @returns formatted username and user_id of the context's `from` user, or "\<N/A\>" if not available
 */
export function printCtxFrom<C extends Context = Context>(ctx: C): string {
  if (!ctx.from) return "<N/A>"
  return printUsername(ctx.from)
}

export async function getOverloadUser<C extends Context>(
  context: C,
  repliedTo: Message | null,
  firstArg?: string | number,
  secondArg?: string
): Promise<Result<{ user: User; reason?: string }, string>> {
  if (repliedTo) {
    if (!repliedTo.from) {
      // error
      return new Err("[getOverloadUser] no repliedTo.from field (the msg was sent in a channel)")
    }
    return new Ok({ user: repliedTo.from, reason: [firstArg, secondArg].filter(Boolean).join(" ") })
  }

  if (!firstArg) return new Err("[getOverloadUser] No firstArg passed (without repliedTo)")

  const userId = typeof firstArg === "number" ? firstArg : await getTelegramId(firstArg).catch(() => null)
  if (!userId) return new Err("[getOverloadUser] Cannot retrieve the userId from arg or redis")

  const user = await getUser(userId, context).catch(() => null)
  if (!user) return new Err("[getOverloadUser] Cannot retrieve the User from chatMember or storage")

  return new Ok({
    user,
    reason: secondArg,
  })
}
