import { ModuleCoordinator } from "@/lib/modules"
import type { ModuleShared } from "@/utils/types"
import { Awaiter } from "@/utils/wait"
import { WebSocketClient } from "@/websocket"
import { BanAllQueue } from "./moderation/ban-all"
import { TgLogger } from "./tg-logger"

export const sharedDataInit = new Awaiter<ModuleShared>()

export const modules = new ModuleCoordinator(
  {
    tgLogger: new TgLogger(-1002685849173, {
      banAll: 13,
      exceptions: 3,
      autoModeration: 7,
      adminActions: 5,
      actionRequired: 10,
      groupManagement: 33,
      deletedMessages: 130,
    }),
    webSocket: new WebSocketClient(),
    banAll: new BanAllQueue(),
  },
  async () => {
    return await sharedDataInit
  }
)
