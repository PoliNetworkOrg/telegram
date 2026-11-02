import { UnrecoverableError } from "bullmq"
import { GrammyError } from "grammy"
import type { ModuleShared } from "@/utils/types"
import type { BanJobCommand, BanJobData } from "./ban-all-flow"

type ExecutorApi = Pick<ModuleShared["api"], "banChatMember" | "unbanChatMember">

export type DeleteAllLastMessages = (userId: number, chatId: number) => Promise<void>

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
  job: { name: BanJobCommand; data: BanJobData },
  deleteAllLastMessages: DeleteAllLastMessages
): Promise<void> {
  switch (job.name) {
    case "ban": {
      const [banResult, deletionResult] = await Promise.allSettled([
        api.banChatMember(job.data.chatId, job.data.targetId, {
          revoke_messages: true,
        }),
        deleteAllLastMessages(job.data.targetId, job.data.chatId),
      ])

      const errors: unknown[] = []
      if (banResult.status === "rejected") errors.push(banResult.reason)
      else if (!banResult.value) errors.push(new Error("Failed to ban user"))
      if (deletionResult.status === "rejected") errors.push(deletionResult.reason)

      if (errors.length > 0) throwJobErrors(errors)
      return
    }
    case "unban": {
      try {
        const success = await api.unbanChatMember(job.data.chatId, job.data.targetId)
        if (!success) throw new Error("Failed to unban user")
        return
      } catch (error) {
        return throwJobErrors([error])
      }
    }
    default:
      throw new Error("Unknown job command")
  }
}
