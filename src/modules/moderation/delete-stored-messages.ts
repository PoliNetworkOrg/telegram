import type { ModuleShared } from "@/utils/types"

type DeleteMessagesApi = Pick<ModuleShared["api"], "deleteMessages">

export async function deleteStoredMessages(
  api: DeleteMessagesApi,
  chatId: number,
  messageIds: number[]
): Promise<boolean> {
  if (messageIds.length === 0) return true
  return await api.deleteMessages(chatId, messageIds)
}
