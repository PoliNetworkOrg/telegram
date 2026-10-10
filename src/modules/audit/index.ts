import { randomUUID } from "node:crypto"
import { TRPCClientError } from "@trpc/client"
import { legacyBackend, serviceBackend, serviceTokens } from "@/backend"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { redis } from "@/redis"
import type { ModuleShared } from "@/utils/types"
import { AuditOutbox, type AuditRecordInput, RedisOutboxStore } from "./outbox"

export type AuditBasis = AuditRecordInput["basis"]
export type AuditType = AuditRecordInput["type"]

/** A moderation action that already happened on Telegram. */
export type AuditEntry = {
  type: AuditType
  targetId: number
  /** Null for network-wide actions (ban_all, unban_all). */
  groupId: number | null
  until: Date | null
  reason?: string
  basis: AuditBasis
  /** Who acted: the person, or the bot itself for automatic actions. */
  actorId: number
}

/** The backend's limit on `reason`. */
const MAX_REASON_LENGTH = 256

/** Errors that mean the backend refused the input itself, which no retry can fix. */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof TRPCClientError)) return false
  const code: unknown = error.data?.code
  return code === "BAD_REQUEST" || code === "PARSE_ERROR"
}

export function toRecordInput(entry: AuditEntry, idempotencyKey: string): AuditRecordInput {
  return {
    idempotencyKey,
    type: entry.type,
    targetId: entry.targetId,
    groupId: entry.groupId,
    until: entry.until,
    reason: entry.reason?.slice(0, MAX_REASON_LENGTH),
    basis: entry.basis,
    // RFC v3 §9.2: automatic actions have no human actor.
    actorTelegramId: entry.basis === "automatic" ? null : entry.actorId,
  }
}

/**
 * Records moderation actions in the backend's audit log (RFC v3 §9.2, §10.2): through the outbox
 * and `tg.auditLog.record` with the service token, or `tg.auditLog.create` while the bot still
 * calls the backend anonymously.
 */
export class AuditLog extends Module<ModuleShared> {
  private outbox = serviceTokens
    ? new AuditOutbox({
        store: new RedisOutboxStore(redis),
        send: (input) => serviceBackend.tg.auditLog.record.mutate(input),
        isPermanent,
        logger,
      })
    : null

  async record(entry: AuditEntry, idempotencyKey = `tg-bot:${randomUUID()}`): Promise<void> {
    if (this.outbox) return this.outbox.enqueue(toRecordInput(entry, idempotencyKey))

    await legacyBackend.tg.auditLog.create
      .mutate({
        adminId: entry.actorId,
        targetId: entry.targetId,
        type: entry.type,
        groupId: entry.groupId,
        until: entry.until,
        reason: entry.reason,
      })
      .catch((error: unknown) => logger.warn({ error, type: entry.type }, "[AUDIT] failed to create audit log"))
  }

  override start() {
    this.outbox?.start()
  }

  override async stop() {
    await this.outbox?.stop()
  }
}
