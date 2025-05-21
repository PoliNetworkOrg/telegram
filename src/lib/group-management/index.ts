import type { AppRouter } from "@polinetwork/backend"
import type { TRPCClient } from "@trpc/client"
import type { Chat, ChatFullInfo } from "grammy/types"
import type { Result } from "neverthrow"

import { err, ok } from "neverthrow"

import { api } from "@/backend"

type GroupDB = Parameters<TRPCClient<AppRouter>["tg"]["groups"]["create"]["mutate"]>[0][0]
export const GroupManagement = {
  async create(chat: ChatFullInfo): Promise<Result<GroupDB, string>> {
    if (!chat.invite_link) {
      return err(`no invite_link, maybe the user does not have permission to "Invite users via link"`)
    }

    const newGroup: GroupDB = { telegramId: chat.id, title: chat.title, link: chat.invite_link }
    const res = await api.tg.groups.create.mutate([newGroup])
    if (!res.length || res[0] !== chat.id) {
      return err(`unknown`)
    }

    return ok(newGroup)
  },
  async delete(chat: Chat): Promise<Result<void, string>> {
    const deleted = await api.tg.groups.delete.mutate({ telegramId: chat.id })
    if (!deleted) return err("it probably wasn't there")
    return ok()
  },
}
