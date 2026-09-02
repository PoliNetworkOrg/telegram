import type { ModuleShared } from "@/utils/types"
import type { BanJobCommand, BanJobData } from "./ban-all-flow"

type ExecutorApi = Pick<ModuleShared["api"], "banChatMember" | "unbanChatMember">

export type DeleteAllLastMessages = (userId: number, chatId: number) => Promise<void>

export async function executeBanAllJob(
  api: ExecutorApi,
  job: { name: BanJobCommand; data: BanJobData },
  deleteAllLastMessages: DeleteAllLastMessages
): Promise<void> {
  switch (job.name) {
    case "ban": {
      const [success] = await Promise.all([
        api.banChatMember(job.data.chatId, job.data.targetId, {
          revoke_messages: true,
        }),
        deleteAllLastMessages(job.data.targetId, job.data.chatId),
      ])

      if (!success) throw new Error("Failed to ban user")
      return
    }
    case "unban": {
      const success = await api.unbanChatMember(job.data.chatId, job.data.targetId)
      if (!success) throw new Error("Failed to unban user")
      return
    }
    default:
      throw new Error("Unknown job command")
  }
}
