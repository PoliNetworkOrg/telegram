import type { Context } from "grammy"
import type { User } from "grammy/types"
import { MessageUserStorage } from "@/middlewares/message-user-storage"

export async function getUser<C extends Context>(userId: number, ctx?: C): Promise<User | null> {
  const chatUser = await ctx
    ?.getChatMember(userId)
    .then((r) => r.user)
    .catch(() => null)

  return chatUser ?? MessageUserStorage.getInstance().getStoredUser(userId)
}
