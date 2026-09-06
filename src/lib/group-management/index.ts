import type { AppRouter } from "@polinetwork/backend"
import type { TRPCClient } from "@trpc/client"
import { GrammyError } from "grammy"
import type { Chat, ChatFullInfo, User } from "grammy/types"
import type { Result } from "neverthrow"

import { err, ok } from "neverthrow"

import { api } from "@/backend"
import { logger } from "@/logger"
import { modules } from "@/modules"
import type { GroupLinkRegenerationFailure } from "@/modules/tg-logger/types"
import { printUsername } from "@/utils/users"
import { wait } from "@/utils/wait"

const LINK_REGENERATION_CONCURRENCY = 3
const TELEGRAM_REQUEST_INTERVAL_MS = 100
const TELEGRAM_FLOOD_RETRIES = 3
const BACKEND_BATCH_SIZE = 50
const BACKEND_ATTEMPTS = 3

type StoredGroup = Awaited<ReturnType<typeof api.tg.groups.getAll.query>>[number]
type GroupDB = Parameters<TRPCClient<AppRouter>["tg"]["groups"]["create"]["mutate"]>[0][0]

export type GroupLinkRegenerationResult = {
  total: number
  regenerated: number
  synchronized: number
  failures: GroupLinkRegenerationFailure[]
}

export type GroupLinkRegenerationResponse =
  | { alreadyRunning: true }
  | { alreadyRunning: false; result: GroupLinkRegenerationResult }
  | { alreadyRunning: false; error: string }

let linkRegenerationInProgress = false

function stripChatInfo(chat: ChatFullInfo) {
  return {
    id: chat.id,
    title: chat.title,
    tag: chat.username,
    is_forum: chat.is_forum,
    type: chat.type,
    invite_link: chat.invite_link,
    username: chat.username,
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

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(/\s+/g, " ").slice(0, 200)
}

function telegramRequestThrottle() {
  let nextRequestAt = 0

  return {
    async waitForSlot() {
      for (;;) {
        const now = Date.now()
        if (now >= nextRequestAt) {
          nextRequestAt = now + TELEGRAM_REQUEST_INTERVAL_MS
          return
        }
        await wait(nextRequestAt - now)
      }
    },
    pause(delayMs: number) {
      nextRequestAt = Math.max(nextRequestAt, Date.now() + delayMs)
    },
  }
}

type TelegramRequestThrottle = ReturnType<typeof telegramRequestThrottle>

async function exportPrimaryInviteLink(groupId: number, throttle: TelegramRequestThrottle): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    await throttle.waitForSlot()
    try {
      return await modules.shared.api.exportChatInviteLink(groupId)
    } catch (error) {
      const retryAfter =
        error instanceof GrammyError && error.error_code === 429 ? error.parameters.retry_after : undefined
      if (retryAfter === undefined || attempt >= TELEGRAM_FLOOD_RETRIES) throw error

      logger.warn(
        { groupId, retryAfter, attempt: attempt + 1 },
        "[GroupManagement] Telegram rate-limited invite link regeneration"
      )
      throttle.pause(retryAfter * 1000)
    }
  }
}

async function regenerateBatch(groups: StoredGroup[]): Promise<{
  updates: GroupDB[]
  failures: GroupLinkRegenerationFailure[]
}> {
  const updates: GroupDB[] = []
  const failures: GroupLinkRegenerationFailure[] = []
  let nextIndex = 0
  const throttle = telegramRequestThrottle()

  const worker = async () => {
    while (nextIndex < groups.length) {
      const group = groups[nextIndex++]
      try {
        const link = await exportPrimaryInviteLink(group.telegramId, throttle)
        updates.push({
          telegramId: group.telegramId,
          title: group.title,
          tag: group.tag ?? undefined,
          link,
        })
      } catch (error) {
        const reason = errorMessage(error)
        failures.push({
          telegramId: group.telegramId,
          title: group.title,
          stage: "TELEGRAM",
          reason,
        })
        logger.warn(
          { error, telegramId: group.telegramId, title: group.title },
          "[GroupManagement] Failed to regenerate group invite link"
        )
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(LINK_REGENERATION_CONCURRENCY, groups.length) }, () => worker()))
  return { updates, failures }
}

async function synchronizeBatch(updates: GroupDB[]): Promise<{
  synchronized: number
  failures: GroupLinkRegenerationFailure[]
}> {
  let lastError: unknown
  let pending = updates
  let synchronized = 0

  for (let attempt = 1; attempt <= BACKEND_ATTEMPTS; attempt++) {
    try {
      const updatedIds = new Set(await api.tg.groups.create.mutate(pending))
      const unconfirmed = pending.filter((group) => !updatedIds.has(group.telegramId))
      synchronized += pending.length - unconfirmed.length
      if (unconfirmed.length === 0) return { synchronized, failures: [] }

      pending = unconfirmed
      lastError = new Error("The backend did not confirm the update.")
      logger.warn(
        { attempt, groupIds: pending.map((group) => group.telegramId) },
        "[GroupManagement] Backend did not confirm every regenerated link"
      )
    } catch (error) {
      lastError = error
      logger.warn(
        { error, attempt, groupIds: pending.map((group) => group.telegramId) },
        "[GroupManagement] Failed to synchronize regenerated links to the backend"
      )
    }

    if (attempt < BACKEND_ATTEMPTS) await wait(500 * attempt)
  }

  return {
    synchronized,
    failures: pending.map((group) => ({
      telegramId: group.telegramId,
      title: group.title,
      stage: "BACKEND",
      reason: errorMessage(lastError),
    })),
  }
}

export const GroupManagement = {
  async regenerateInviteLinks(requestedBy: User): Promise<GroupLinkRegenerationResponse> {
    if (linkRegenerationInProgress) return { alreadyRunning: true }
    linkRegenerationInProgress = true

    try {
      const startLog = await modules.get("tgLogger").groupManagement({ type: "REGENERATE_LINKS_START", requestedBy })
      if (startLog === null) throw new Error("Cannot log the operation in the Group Management topic.")

      const groups = await api.tg.groups.getAll.query()
      const result: GroupLinkRegenerationResult = {
        total: groups.length,
        regenerated: 0,
        synchronized: 0,
        failures: [],
      }

      for (let offset = 0; offset < groups.length; offset += BACKEND_BATCH_SIZE) {
        const batch = groups.slice(offset, offset + BACKEND_BATCH_SIZE)
        const regenerated = await regenerateBatch(batch)
        result.regenerated += regenerated.updates.length
        result.failures.push(...regenerated.failures)

        if (regenerated.updates.length > 0) {
          const synchronized = await synchronizeBatch(regenerated.updates)
          result.synchronized += synchronized.synchronized
          result.failures.push(...synchronized.failures)
        }
      }

      await modules.get("tgLogger").groupManagement({
        type: "REGENERATE_LINKS_COMPLETE",
        requestedBy,
        ...result,
      })
      logger.info(
        {
          requestedBy: printUsername(requestedBy),
          total: result.total,
          regenerated: result.regenerated,
          synchronized: result.synchronized,
          failures: result.failures,
        },
        "[GroupManagement] Group invite link regeneration completed"
      )
      return { alreadyRunning: false, result }
    } catch (error) {
      const reason = errorMessage(error)
      await modules
        .get("tgLogger")
        .groupManagement({ type: "REGENERATE_LINKS_ABORTED", requestedBy, reason })
        .catch(() => {})
      logger.error({ error, requestedBy: printUsername(requestedBy) }, "[GroupManagement] Link regeneration aborted")
      return { alreadyRunning: false, error: reason }
    } finally {
      linkRegenerationInProgress = false
    }
  },

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
