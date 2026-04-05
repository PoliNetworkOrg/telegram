import { ModuleCoordinator } from "@/lib/modules"
import { WebSocketClient } from "@/modules/websocket"
import type { ModuleShared } from "@/utils/types"
import { Awaiter } from "@/utils/wait"
import { BanAllQueue } from "./moderation/ban-all"
import { InfluxClient } from "./telemetry/influxdb"
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
      grants: 402,
    }),
    webSocket: new WebSocketClient(),
    banAll: new BanAllQueue(),
    influx: new InfluxClient(),
  },
  async () => {
    return await sharedDataInit
  }
)
