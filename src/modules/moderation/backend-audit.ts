import { api } from "@/backend"
import { logger } from "@/logger"
import { modules } from ".."
import type { Duration } from "@/utils/duration"
import type { Chat, Message, User } from "grammy/types"

export type ModerationAuditStatus = "pending" | "running" | "completed" | "partial" | "failed"
export type ModerationAuditType = "ban" | "unban" | "kick" | "mute" | "unmute" | "multi_chat_spam" | "ban_all" | "unban_all"
export type ModerationAuditAction = "BAN" | "UNBAN" | "KICK" | "MUTE" | "UNMUTE" | "MULTI_CHAT_SPAM" | "SILENT"

type AuditProgress = {
  status?: ModerationAuditStatus
  deletedMessageCount?: number | null
  totalGroupCount?: number
  successGroupCount?: number
  failedGroupCount?: number
}

/**
 * Protocol for a moderation audit.
 *
 * `category` is the wire-level discriminator. The backend uses it to select
 * the destination table, while `action` describes the actual moderation
 * operation. Keep `type` aligned with the backend's stored audit type.
 *
 * Example:
 * ```ts
 * {
 *   category: "moderation",
 *   action: "BAN",
 *   type: "ban",
 *   adminId: moderator.id,
 *   targetId: target.id,
 *   groupId: chat.id,
 *   until: null,
 *   from: moderator,
 *   target,
 *   chat,
 * }
 * ```
 *
 * To add a new moderation command: add its Telegram action to
 * `ModerationAuditAction`, add its persisted value to `ModerationAuditType`,
 * update the backend `moderationInput` enum, then call `auditModeration` with
 * both values. Do not create a raw `tg.auditLog.create` call in the command.
 */
type ModerationAuditCreate = AuditProgress & {
  category: "moderation"
  adminId: number
  targetId: number
  type: Exclude<ModerationAuditType, "ban_all" | "unban_all">
  action: ModerationAuditAction
  groupId: number | null
  until: Date | null
  reason?: string
  duration?: Duration
  preDeleteRes?: { count: number; logMessageIds: number[]; link?: string } | null
  chat: Chat
  from: User
  target: User
  messages?: Message[]
  source?: "manual" | "auto" | "chat_member_update"
}

/** Protocol for a cross-group ban or unban operation. */
type BanAllAuditCreate = {
  category: "ban_all"
  adminId: number
  targetId: number
  type: "ban_all" | "unban_all"
  action?: "BAN" | "UNBAN"
  groupId: number | null
  until: Date | null
  reason?: string
  from?: User
  target?: User
  source?: "manual" | "auto"
}

/**
 * Protocol for one successfully deleted Telegram message.
 *
 * Deletion is intentionally one request per message. `preDeleteRes` belongs
 * to Telegram's human-readable moderation log and is not part of this event.
 */
type DeletedAuditCreate = {
  category: "deleted"
  messageId: number
  chatId: number
  authorId: number
  author?: User
  deletedById: number
  deletedBy: User
  deletedAt: Date
  reason?: string
  source?: "moderation" | "auto" | "manual"
}

/** Protocol for an exception or error observed by the bot. */
type ExceptionAuditCreate = {
  category: "exception"
  type: "UNHANDLED_PROMISE" | "BOT_ERROR" | "HTTP_ERROR" | "GENERIC" | "UNKNOWN"
  error: unknown
  context?: unknown
  source?: "bot" | "api" | "web"
}

/** Protocol for a group lifecycle or group-management event. */
type GroupManagementAuditCreate = {
  category: "group_management"
  type: "LEAVE" | "LEAVE_FAIL" | "DELETE" | "CREATE" | "UPDATE" | "CREATE_FAIL" | "UPDATE_FAIL" | "REGENERATE_LINKS_START" | "REGENERATE_LINKS_COMPLETE" | "REGENERATE_LINKS_ABORTED"
  chat?: Chat
  addedBy?: User
  inviteLink?: string
  reason?: string
  requestedBy?: User
  total?: number
  regenerated?: number
  synchronized?: number
  failures?: Array<{ telegramId: number; title: string; stage: "TELEGRAM" | "BACKEND"; reason: string }>
  source?: "bot" | "api"
}

/** Protocol for grant usage, creation, and interruption events. */
type GrantAuditCreate = {
  category: "grant"
  action: "usage" | "create" | "interrupt"
  from?: User
  message?: Message
  chat?: Chat
  target?: User
  by?: User
  since?: Date
  until?: Date
  reason?: string
  interruptedBy?: User
  source?: "bot" | "api"
}

/**
 * Complete bot-to-backend audit protocol.
 *
 * Every new category must be added here, in the backend router's
 * discriminated union, and in `audit()` below. This keeps invalid payloads
 * from compiling and makes the routing exhaustive.
 */
type BackendAuditCreate = ModerationAuditCreate | BanAllAuditCreate | DeletedAuditCreate | ExceptionAuditCreate | GroupManagementAuditCreate | GrantAuditCreate

/** The only backend calls used by this module. All callers use typed helpers. */
const auditLog = api.tg.auditLog as unknown as {
  create: { mutate: (input: BackendAuditCreate) => Promise<{ id: number } | null | void> }
  update: { mutate: (input: AuditProgress & { id: number }) => Promise<{ updated: boolean }> }
  markMessagesDeleted: { mutate: (input: { chatId: number; messageIds: number[] }) => Promise<{ count: number; deletedAt: Date }> }
}

export type TelegramLogOptions =
  | { logToTelegram: false }
  | { logToTelegram: true; tgLogger?: InstanceType<typeof import("@/modules/tg-logger").TgLogger> }

export type ModerationAuditInput = ModerationAuditCreate & { telegramLog?: TelegramLogOptions }
export type BanAllAuditInput = BanAllAuditCreate & { telegramLog?: TelegramLogOptions }
export type DeletedAuditInput = DeletedAuditCreate & { telegramLog?: TelegramLogOptions }
export type ExceptionAuditInput = ExceptionAuditCreate & { telegramLog?: TelegramLogOptions }
export type GroupManagementAuditInput = GroupManagementAuditCreate & { telegramLog?: TelegramLogOptions }
export type GrantAuditInput = GrantAuditCreate & { telegramLog?: TelegramLogOptions }
export type AuditInput = ModerationAuditInput | BanAllAuditInput | DeletedAuditInput | ExceptionAuditInput | GroupManagementAuditInput | GrantAuditInput

/**
 * Sends one validated audit event to the backend.
 *
 * The backend returns the inserted row ID. It is required for moderation and
 * ban-all progress updates; duplicate inserts may return `null` because the
 * backend uses `onConflictDoNothing`.
 */
async function createAudit(input: BackendAuditCreate): Promise<number | void> {
  const created = await auditLog.create.mutate(input)
  if (created && "id" in created) return created.id
}

/** Create a `moderation` event and optionally mirror it to Telegram. */
export async function auditModeration(input: ModerationAuditInput, telegramLog = input.telegramLog): Promise<number> {
  const { telegramLog: _, ...auditInput } = input
  const created = await createAudit({ ...auditInput, reason: auditInput.reason?.slice(0, 256) })
  if (created === undefined) throw new Error("Backend did not create the moderation audit record")
  if (telegramLog?.logToTelegram) {
    const tgLogger = telegramLog.tgLogger ?? modules.get("tgLogger") as InstanceType<typeof import("@/modules/tg-logger").TgLogger>
    try {
      await tgLogger.moderationAction({ action: auditInput.action, from: auditInput.from, target: auditInput.target, chat: auditInput.chat, reason: auditInput.reason, duration: auditInput.duration, preDeleteRes: auditInput.preDeleteRes ? { ...auditInput.preDeleteRes, link: auditInput.preDeleteRes.link ?? "", recentMessageCount: null, successfulChatIds: [], failedChatIds: [] } : null } as Parameters<typeof tgLogger.moderationAction>[0])
    } catch (error) {
      logger.warn({ error, auditId: created }, "Failed to log moderation action to Telegram")
    }
  }
  return created
}

/** Create a `ban_all` event and return its ID for queue progress updates. */
export async function auditBanAll(input: BanAllAuditInput): Promise<number> {
  const { telegramLog: _, ...auditInput } = input
  const created = await createAudit(auditInput)
  if (created === undefined) throw new Error("Backend did not create the ban_all audit record")
  return created
}

/** Create one `deleted` event for one successfully deleted message. */
export async function auditDeleted(input: DeletedAuditInput): Promise<void> {
  const { telegramLog: _, ...auditInput } = input
  await createAudit(auditInput)
}

/** Create an `exception` event and optionally mirror it to Telegram. */
export async function auditException(input: ExceptionAuditInput): Promise<void> {
  const { telegramLog, ...auditInput } = input
  await createAudit(auditInput)
  if (telegramLog?.logToTelegram) {
    const tgLogger = telegramLog.tgLogger ?? modules.get("tgLogger") as InstanceType<typeof import("@/modules/tg-logger").TgLogger>
    await tgLogger.exception({ type: auditInput.type, error: auditInput.error } as Parameters<typeof tgLogger.exception>[0], String(auditInput.context ?? ""))
  }
}

/** Create a `group_management` event and optionally mirror it to Telegram. */
export async function auditGroupManagement(input: GroupManagementAuditInput): Promise<void> {
  const { telegramLog, ...auditInput } = input
  await createAudit(auditInput)
  if (telegramLog?.logToTelegram) {
    const tgLogger = telegramLog.tgLogger ?? modules.get("tgLogger") as InstanceType<typeof import("@/modules/tg-logger").TgLogger>
    await tgLogger.groupManagement(auditInput as Parameters<typeof tgLogger.groupManagement>[0])
  }
}

/** Create a `grant` event and optionally mirror it to Telegram. */
export async function auditGrant(input: GrantAuditInput): Promise<void> {
  const { telegramLog, ...auditInput } = input
  await createAudit(auditInput)
  if (telegramLog?.logToTelegram) {
    const tgLogger = telegramLog.tgLogger ?? modules.get("tgLogger") as InstanceType<typeof import("@/modules/tg-logger").TgLogger>
    await tgLogger.grants({ ...auditInput, action: auditInput.action.toUpperCase() as "USAGE" | "CREATE" | "INTERRUPT" } as Parameters<typeof tgLogger.grants>[0])
  }
}

/**
 * Update progress fields on an existing `moderation` audit row.
 *
 * Use this only with the ID returned by `auditModeration` or `auditBanAll`.
 * Example: `await updateAudit(auditId, { status: "running", successGroupCount: 2 })`.
 */
export async function updateAudit(id: number, progress: AuditProgress): Promise<void> {
  const result = await auditLog.update.mutate({ id, ...progress })
  if (!result.updated) throw new Error(`Moderation audit record ${id} was not found`)
}

/**
 * Mark stored Telegram messages as deleted after Telegram confirms deletion.
 *
 * This is bookkeeping, not an audit event. Call `auditDeleted` separately for
 * every successful message so the deleted-message audit contains its author,
 * executor, reason, and timestamp.
 */
export async function markMessagesDeleted(chatId: number, messageIds: number[]): Promise<number> {
  if (messageIds.length === 0) return 0
  const result = await auditLog.markMessagesDeleted.mutate({ chatId, messageIds })
  return result.count
}

/**
 * Route a category-specific event to its typed helper.
 *
 * To add a new category:
 * 1. Define its fields and literal `category` type above.
 * 2. Add it to `BackendAuditCreate`, `AuditInput`, and the backend router.
 * 3. Add a dedicated `auditX()` helper if it needs special behavior.
 * 4. Add a switch branch here and a focused test with a representative payload.
 * 5. Update the backend table insert and Zod schema; never add legacy fallback.
 */
export async function audit(input: AuditInput): Promise<number | void> {
  switch (input.category) {
    case "moderation": return await auditModeration(input)
    case "ban_all": return await auditBanAll(input)
    case "deleted": return await auditDeleted(input)
    case "exception": return await auditException(input)
    case "group_management": return await auditGroupManagement(input)
    case "grant": return await auditGrant(input)
  }
}
