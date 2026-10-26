import type { ChatMember } from "grammy/types"

type Logger = {
  warn: (obj: object, msg: string) => void
  info: (obj: object, msg: string) => void
}

/** Where the bot keeps what Telegram last said about each group's admins: a cache, never a source. */
export type GroupAdminsStore = {
  read: (chatId: number) => Promise<number[] | undefined>
  write: (chatId: number, userIds: number[]) => Promise<void>
}

export type GroupAdminsSyncDeps = {
  /** Telegram's `getChatAdministrators`. */
  getChatAdministrators: (chatId: number) => Promise<ChatMember[]>
  /** The Telegram IDs of the groups the backend stores. */
  listGroups: () => Promise<number[]>
  store: GroupAdminsStore
  logger: Logger
  /** Pause between Telegram requests during a full refresh. */
  wait: (ms: number) => Promise<void>
  /** How long to wait for more admin changes in a chat before reading it once. */
  debounceMs?: number
  requestIntervalMs?: number
}

const isAdminStatus = (status: ChatMember["status"]) => status === "creator" || status === "administrator"

/** The people who administer a chat: its creator and administrators, without bots. */
export function toAdminIds(members: ChatMember[]): number[] {
  return [...new Set(members.filter((m) => isAdminStatus(m.status) && !m.user.is_bot).map((m) => m.user.id))]
}

/** Whether a `chat_member` update changes who administers the chat. */
export function changesAdmins(oldMember: ChatMember, newMember: ChatMember): boolean {
  if (newMember.user.is_bot) return false
  return oldMember.status !== newMember.status && (isAdminStatus(oldMember.status) || isAdminStatus(newMember.status))
}

/**
 * Keeps the bot's cache of each group's native Telegram admins (RFC v3 decision 2) fresh. Telegram is the only source:
 * the backend asks the bot for the cached lists and stores nothing.
 */
export function createGroupAdminsSync(deps: GroupAdminsSyncDeps) {
  const debounceMs = deps.debounceMs ?? 5_000
  const requestIntervalMs = deps.requestIntervalMs ?? 100
  const pending = new Map<number, ReturnType<typeof setTimeout>>()
  let fullRefreshRunning = false

  async function refreshChat(chatId: number): Promise<boolean> {
    try {
      await deps.store.write(chatId, toAdminIds(await deps.getChatAdministrators(chatId)))
      return true
    } catch (error) {
      deps.logger.warn({ error, chatId }, "[GroupAdmins] cannot read the chat's admins")
      return false
    }
  }

  return {
    refreshChat,

    /** Reads a chat once its admin changes settle, so a burst of promotions makes one request. */
    schedule(chatId: number) {
      clearTimeout(pending.get(chatId))
      pending.set(
        chatId,
        setTimeout(() => {
          pending.delete(chatId)
          void refreshChat(chatId)
        }, debounceMs)
      )
    },

    /** Reads every stored group, one Telegram request at a time. Skipped while another full refresh runs. */
    async refreshAll(): Promise<{ refreshed: number; total: number } | null> {
      if (fullRefreshRunning) return null
      fullRefreshRunning = true
      try {
        const groups = await deps.listGroups()
        let refreshed = 0
        for (const [index, chatId] of groups.entries()) {
          if (index > 0) await deps.wait(requestIntervalMs)
          if (await refreshChat(chatId)) refreshed++
        }
        deps.logger.info({ refreshed, total: groups.length }, "[GroupAdmins] full refresh done")
        return { refreshed, total: groups.length }
      } finally {
        fullRefreshRunning = false
      }
    },

    /** The cached admins of the given groups, for the backend; groups not read yet are left out. */
    async cached(chatIds: number[]): Promise<{ chatId: number; userIds: number[] }[]> {
      const entries = await Promise.all(
        chatIds.map(async (chatId) => ({ chatId, userIds: await deps.store.read(chatId).catch(() => undefined) }))
      )
      return entries.flatMap(({ chatId, userIds }) => (userIds ? [{ chatId, userIds }] : []))
    },
  }
}
