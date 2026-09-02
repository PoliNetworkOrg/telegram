import { api } from "@/backend"

export type ModerationAuditStatus = "pending" | "running" | "completed" | "partial" | "failed"

export type ModerationAuditType =
  | "ban"
  | "unban"
  | "kick"
  | "mute"
  | "unmute"
  | "delete"
  | "multi_chat_spam"
  | "ban_all"
  | "unban_all"

type AuditProgress = {
  status?: ModerationAuditStatus
  deletedMessageCount?: number | null
  totalGroupCount?: number
  successGroupCount?: number
  failedGroupCount?: number
}

type AuditCreate = AuditProgress & {
  adminId: number
  targetId: number
  groupId: number | null
  type: ModerationAuditType
  until: Date | null
  reason?: string
}

// The backend package is released separately from the bot. Keep the new procedure
// shapes behind this module until the next package release reaches this repository.
const auditLog = api.tg.auditLog as unknown as {
  create: { mutate: (input: AuditCreate) => Promise<{ id: number } | null> }
  update: { mutate: (input: AuditProgress & { id: number }) => Promise<{ updated: boolean }> }
}

const messages = api.tg.messages as unknown as {
  markDeleted: {
    mutate: (input: { chatId: number; messageIds: number[] }) => Promise<{ count: number; deletedAt: Date }>
  }
}

export const backendModerationLog = {
  async create(input: AuditCreate): Promise<number> {
    const created = await auditLog.create.mutate({
      ...input,
      reason: input.reason?.slice(0, 256),
    })
    if (!created) throw new Error("Backend did not create the moderation audit record")
    return created.id
  },

  async update(id: number, progress: AuditProgress): Promise<void> {
    const result = await auditLog.update.mutate({ id, ...progress })
    if (!result.updated) throw new Error(`Moderation audit record ${id} was not found`)
  },

  async markMessagesDeleted(chatId: number, messageIds: number[]): Promise<number> {
    if (messageIds.length === 0) return 0
    const result = await messages.markDeleted.mutate({ chatId, messageIds })
    return result.count
  },
}
