import { UnrecoverableError } from "bullmq"
import { GrammyError } from "grammy"
import type { ModuleShared } from "@/utils/types"
import type { BanJobCommand, BanJobData, BanJobResult } from "./ban-all-flow"

type ExecutorApi = Pick<ModuleShared["api"], "banChatMember" | "unbanChatMember">

export type DeleteAllLastMessages = (userId: number, chatId: number) => Promise<number | null>

function isPermanentTelegramError(error: unknown): error is GrammyError {
  return error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 && error.error_code !== 429
}

function throwJobErrors(errors: unknown[]): never {
  const retryableError = errors.find((error) => !isPermanentTelegramError(error))
  if (retryableError) throw retryableError

  const permanentError = errors[0]
  throw new UnrecoverableError(permanentError instanceof Error ? permanentError.message : String(permanentError))
}

export async function executeBanAllJob(
  api: ExecutorApi,
  job: { name: BanJobCommand; data: BanJobData; updateData: (data: BanJobData) => Promise<void> },
  deleteAllLastMessages: DeleteAllLastMessages
): Promise<BanJobResult> {
  switch (job.name) {
    case "ban": {
      const storedDeletionCount = job.data.deletedMessageCount
      const [banResult, deletionResult] = await Promise.allSettled([
        api.banChatMember(job.data.chatId, job.data.targetId, {
          revoke_messages: true,
        }),
        storedDeletionCount === undefined
          ? deleteAllLastMessages(job.data.targetId, job.data.chatId)
          : Promise.resolve(storedDeletionCount),
      ])

      const errors: unknown[] = []
      if (banResult.status === "rejected") errors.push(banResult.reason)
      else if (!banResult.value) errors.push(new Error("Failed to ban user"))

      if (deletionResult.status === "rejected") {
        errors.push(deletionResult.reason)
      } else if (storedDeletionCount === undefined) {
        await job
          .updateData({ ...job.data, deletedMessageCount: deletionResult.value })
          .catch((error: unknown) => errors.push(error))
      }

      if (errors.length > 0) throwJobErrors(errors)
      return { deletedMessageCount: deletionResult.status === "fulfilled" ? deletionResult.value : null }
    }
    case "unban": {
      try {
        const success = await api.unbanChatMember(job.data.chatId, job.data.targetId)
        if (!success) throw new Error("Failed to unban user")
        return { deletedMessageCount: 0 }
      } catch (error) {
        return throwJobErrors([error])
      }
    }
    default:
      throw new Error("Unknown job command")
  }
}
