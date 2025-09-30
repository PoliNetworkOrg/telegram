import { sharedDataInit } from "./bot"
import { ModuleCoordinator } from "./lib/modules"
import { TgLogger } from "./lib/tg-logger"

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
  },
  async () => {
    return await sharedDataInit
  }
)
