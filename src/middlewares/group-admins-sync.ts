import { Cron } from "croner"
import type { Context } from "grammy"
import { serviceBackend } from "@/backend"
import { changesAdmins, createGroupAdminsSync } from "@/lib/group-admins"
import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { type TelemetryContextFlavor, TrackedMiddleware } from "@/modules/telemetry"
import { redis } from "@/redis"
import { wait } from "@/utils/wait"

/** After joining, give BotMembershipHandler time to store the group. */
const JOIN_DELAY_MS = 30_000
const STARTUP_DELAY_MS = 120_000
/** Refreshed every 6 hours: an entry that outlives a day belongs to a group the bot can no longer read. */
const CACHE_TTL_SECONDS = 24 * 60 * 60

const cache = new RedisFallbackAdapter<number[]>({ redis, prefix: "group_admins", ttl: CACHE_TTL_SECONDS, logger })

/** The bot's cache of each group's native Telegram admins (RFC v3 decision 2), which the backend reads for People. */
export const groupAdmins = createGroupAdminsSync({
  getChatAdministrators: (chatId) => modules.shared.api.getChatAdministrators(chatId),
  listGroups: async () => (await serviceBackend.tg.groups.getAll.query()).map((group) => group.telegramId),
  store: {
    read: (chatId) => cache.read(String(chatId)),
    write: (chatId, userIds) => cache.write(String(chatId), userIds),
  },
  logger,
  wait,
})

/** Refreshes the cache on admin changes, when the bot is promoted in a group, at startup and every 6 hours. */
export class GroupAdminsSync<C extends TelemetryContextFlavor<Context>> extends TrackedMiddleware<C> {
  constructor() {
    super("group_admins_sync")

    const refreshAll = () =>
      void groupAdmins.refreshAll().catch((error) => logger.error({ error }, "[GroupAdmins] full refresh failed"))
    setTimeout(refreshAll, STARTUP_DELAY_MS)
    new Cron("0 17 */6 * * *", refreshAll)

    this.composer.on("chat_member", async (ctx, next) => {
      const { chat, old_chat_member: oldMember, new_chat_member: newMember } = ctx.chatMember
      if (chat.type !== "private" && changesAdmins(oldMember, newMember)) groupAdmins.schedule(chat.id)
      await next()
    })

    this.composer.on("my_chat_member", async (ctx, next) => {
      const { chat, new_chat_member: me } = ctx.myChatMember
      if (chat.type !== "private" && me.status === "administrator")
        setTimeout(() => void groupAdmins.refreshChat(chat.id), JOIN_DELAY_MS)
      await next()
    })
  }
}
