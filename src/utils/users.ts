import type { Context } from "grammy"
import type { User } from "grammy/types"
import { err, ok, type Result } from "neverthrow"
import { api } from "@/backend"
import { logger } from "@/logger"
import { toGrammyUser } from "./types"

export async function getUser<C extends Context>(userId: number, ctx?: C): Promise<Result<User, string>> {
  const chatUser = await ctx
    ?.getChatMember(userId)
    .then((r) => r.user)
    .catch(() => null)

  if (chatUser) return ok(chatUser)

  try {
    const { user, error } = await api.tg.users.get.query({ userId })
    if (user) return ok(toGrammyUser(user))

    return err(error)
  } catch (error) {
    logger.error({ error }, "getUser: error while calling the API")
    return err("INTERNAL_SERVER_ERROR")
  }
}
