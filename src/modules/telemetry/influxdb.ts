import { InfluxDB, type Point, type WriteApi } from "@influxdata/influxdb-client"
import { env } from "@/env"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { throttle } from "@/utils/throttle"
import type { ModuleShared } from "@/utils/types"

export class InfluxClient extends Module<ModuleShared> {
  private client?: InfluxDB
  private writeApi?: WriteApi
  private flush: () => void = () => {}

  constructor() {
    super()
    const token = env.INFLUXDB_TOKEN
    const url = env.INFLUXDB_URL
    if (token) {
      this.client = new InfluxDB({ url, token })
      this.writeApi = this.client.getWriteApi("polinetwork", "telegram_bot")
      this.flush = throttle(async () => {
        if (!this.writeApi) return
        try {
          await this.writeApi.flush()
        } catch (error) {
          logger.error({ error }, "[InfluxDB] Error flushing data")
        }
      }, 5000)
    } else {
      logger.warn("[InfluxDB] Token not found, telemetry will be disabled")
    }
  }

  writePoint(point: Point) {
    if (!this.writeApi) return
    this.writeApi.writePoint(point)
    this.flush()
  }

  override async stop(): Promise<void> {
    if (this.writeApi) {
      await this.writeApi.close().catch((error) => {
        logger.error({ error }, "[InfluxDB] Error closing write API")
      })
    }
  }
}
