import type { Context } from "grammy"
import type { Message, User } from "grammy/types"
import { Err, Ok, type Result } from "neverthrow"
import { MessageUserStorage } from "@/middlewares/message-user-storage"
import { getTelegramId } from "./telegram-id"
import { logger } from "@/logger"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"

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

export async function getOverloadUser<C extends Context>(
  context: C,
  repliedTo: Message | null,
  firstArg?: string | number,
  secondArg?: string
): Promise<Result<{ user: User; reason?: string }, string>> {
  if (repliedTo) {
    if (!repliedTo.from) {
      return new Err("[getOverloadUser] no repliedTo.from field")
    }
    return new Ok({ user: repliedTo.from, reason: [firstArg, secondArg].filter(Boolean).join(" ") })
  }

  const user = await resolveUser(firstArg, context)
  if (!user) {
    return new Err("SILENT_ERROR")
  }

  return new Ok({
    user,
    reason: secondArg as string | undefined,
  })
}


export async function resolveUser(
  usernameOrId: string | number | undefined,
  c: Context
): Promise<User | null> {
  if (!usernameOrId) return null

  const userId: number | null =
    typeof usernameOrId === "string"
      ? await getTelegramId(usernameOrId.replaceAll("@", "")).catch(() => null)
      : typeof usernameOrId === "number"
        ? usernameOrId
        : null

  if (!userId) {
    logger.debug(`warns: no userId for username/id ${usernameOrId}`)
    const msg = await c.reply(fmt(({ b }) => b`@${c.from?.username} user not found`))
    void ephemeral(msg)
    return null
  }

  const user = await getUser(userId, c).catch(() => null)
  if (!user) {
    const msg = await c.reply(fmt(({ n }) => n`Error: cannot find this user`))
    logger.error({ userId }, "WARNS: cannot retrieve the user")
    void ephemeral(msg)
    return null
  }

  return user
}