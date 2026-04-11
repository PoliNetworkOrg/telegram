import type { AppRouter } from "@polinetwork/backend"
import type { TRPCClient } from "@trpc/client"
import type { Chat, ChatFullInfo, User } from "grammy/types"
import type { Result } from "neverthrow"

import { err, ok } from "neverthrow"

import { api } from "@/backend"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { printUsername } from "@/utils/users"

function stripChatInfo(chat: ChatFullInfo) {
  return {
    id: chat.id,
    title: chat.title,
    tag: chat.username,
    is_forum: chat.is_forum,
    type: chat.type,
    invite_link: chat.invite_link,
  }
}

async function errorNoInviteLink(chat: ChatFullInfo, type: "CREATE" | "UPDATE") {
  const reason = "Missing invite_link, probably the bot is not admin or does not have permission to invite via link"
  logger.error({ chat: stripChatInfo(chat), reason }, `[GroupManagement] Cannot ${type} group`)
  await modules.get("tgLogger").groupManagement({
    type: type === "CREATE" ? "CREATE_FAIL" : "UPDATE_FAIL",
    chat,
    reason,
  })
  return err(reason)
}

async function errorBackend(chat: ChatFullInfo, type: "CREATE" | "UPDATE", fatal: boolean = false) {
  if (fatal) logger.fatal("[GroupManagement] HELP! Sent and recieved chatId do not match")
  const reason = `${fatal ? "FATAL " : ""}There was an error in the backend`
  logger.error({ chat: stripChatInfo(chat), reason }, `[GroupManagement] Cannot ${type} group`)
  await modules.get("tgLogger").groupManagement({
    type: type === "CREATE" ? "CREATE_FAIL" : "UPDATE_FAIL",
    chat,
    inviteLink: chat.invite_link,
    reason,
  })
  return err(reason)
}

type GroupDB = Parameters<TRPCClient<AppRouter>["tg"]["groups"]["create"]["mutate"]>[0][0]
export const GroupManagement = {
  async create(chatId: number, addedBy: User): Promise<Result<GroupDB, string>> {
    const { status } = await modules.shared.api
      .getChatMember(chatId, modules.shared.botInfo.id)
      .catch(() => ({ status: null }))
    if (status !== "administrator") {
      const reason = "The bot is not an administrator"
      logger.error({ chatId, reason }, "[GroupManagement] Cannot CREATE group")
      return err(reason)
    }

    const chat = await modules.shared.api.getChat(chatId).catch(() => null)

    if (!chat) {
      const reason = "The bot cannot retrieve chat info, probably it is not an administrator"
      logger.error({ chatId, reason }, "[GroupManagement] Cannot CREATE group")
      await modules.get("tgLogger").exception({
        type: "GENERIC",
        error: new Error("Cannot execute GroupManagement.create because the bot cannot fetch the chat from API."),
      })
      return err(reason)
    }

    if (!chat.invite_link) {
      return errorNoInviteLink(chat, "CREATE")
    }

    // chat.username does not start with @
    const newGroup: GroupDB = { telegramId: chat.id, title: chat.title, link: chat.invite_link, tag: chat.username }
    const res = await api.tg.groups.create.mutate([newGroup])
    if (!res.length || res[0] !== chat.id) {
      return errorBackend(chat, "CREATE", res.length >= 1 && res[0] !== chat.id)
    }

    await modules.get("tgLogger").groupManagement({ type: "CREATE", chat, addedBy, inviteLink: chat.invite_link })
    logger.info(
      { chat: stripChatInfo(chat), addedBy: printUsername(addedBy) },
      "[GroupManagement] CREATE group success"
    )
    return ok(newGroup)
  },

  async update(chatId: number, requestedBy: User): Promise<Result<GroupDB, string>> {
    const { status } = await modules.shared.api
      .getChatMember(chatId, modules.shared.botInfo.id)
      .catch(() => ({ status: null }))
    if (status !== "administrator") {
      const reason = "The bot is not an administrator"
      logger.error({ chatId, reason }, "[GroupManagement] Cannot UPDATE group")
      return err(reason)
    }

    const chat = await modules.shared.api.getChat(chatId).catch(() => null)
    if (!chat) {
      const reason = "The bot is not in this group or is not an administrator"
      logger.warn({ chatId, reason }, "[GroupManagement] Cannot UPDATE group")
      return err(reason)
    }

    if (!chat.invite_link) {
      return errorNoInviteLink(chat, "UPDATE")
    }

    const saved = await api.tg.groups.getById.query({ telegramId: chat.id }).catch(() => null)
    if (!saved) {
      const reason = "Group with this chatId does not exist in the database."
      logger.warn({ chat: stripChatInfo(chat), reason }, "[GroupManagement] Cannot UPDATE group")
      return err(reason)
    }

    // chat.username does not start with @
    const updatedGroup: GroupDB = { telegramId: chat.id, title: chat.title, link: chat.invite_link, tag: chat.username }
    const res = await api.tg.groups.create.mutate([updatedGroup])
    if (!res.length || res[0] !== chat.id) {
      return errorBackend(chat, "UPDATE", res.length >= 1 && res[0] !== chat.id)
    }

    await modules
      .get("tgLogger")
      .groupManagement({ type: "UPDATE", chat, addedBy: requestedBy, inviteLink: chat.invite_link })
    logger.info(
      { chat: stripChatInfo(chat), requestedBy: printUsername(requestedBy) },
      "[GroupManagement] UPDATE group success"
    )
    return ok(updatedGroup)
  },

  async delete(chat: Chat): Promise<Result<void, string>> {
    const deleted = await api.tg.groups.delete.mutate({ telegramId: chat.id })
    if (!deleted) {
      const reason = "Group with this chatId does not exist in the database."
      logger.warn({ chat, reason }, "[GroupManagement] Cannot DELETE group")
      return err(reason)
    }

    await modules.get("tgLogger").groupManagement({ type: "DELETE", chat })
    logger.info({ chat }, "[GroupManagement] DELETE group success")
    return ok()
  },

  async checkAdderPermission(chat: Chat, addedBy: User): Promise<boolean> {
    const { allowed } = await api.tg.permissions.canAddBot.query({ userId: addedBy.id })
    if (allowed) {
      logger.debug(
        { chat, addedBy: printUsername(addedBy), allowed },
        `[GroupManagement] checkAdderPermission result: ALLOWED`
      )
      return true
    }

    const left = await modules.shared.api.leaveChat(chat.id).catch(() => false)
    if (!left) {
      await modules.get("tgLogger").groupManagement({
        type: "LEAVE_FAIL",
        chat,
        addedBy,
      })
      logger.error(
        { chat, addedBy: printUsername(addedBy), allowed, left },
        `[GroupManagement] checkAdderPermission result: DENIED. Cannot leave unauthorized group`
      )
      return false
    }

    await modules.get("tgLogger").groupManagement({ type: "LEAVE", chat, addedBy: addedBy })
    logger.warn(
      { chat, addedBy: printUsername(addedBy), allowed, left },
      `[GroupManagement] checkAdderPermission result: DENIED. LEFT unauthorized group`
    )
    return false
  },
}
