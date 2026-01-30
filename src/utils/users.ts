import type { Context } from "grammy"
import type { User } from "grammy/types"
import { MessageUserStorage } from "@/middlewares/message-user-storage"

export async function getUser<C extends Context>(userId: number, ctx: C | null): Promise<User | null> {
  // TODO: check if this works correctly
  const chatUser = ctx ? await ctx.getChatMember(userId).catch(() => null) : null
  return chatUser?.user ?? MessageUserStorage.getInstance().getStoredUser(userId)
}
