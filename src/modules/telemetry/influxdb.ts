import { InfluxDB, type Point, type WriteApi } from "@influxdata/influxdb-client"
import { env } from "@/env"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { throttle } from "@/utils/throttle"
import type { ModuleShared } from "@/utils/types"

/**
 * A thin module that wraps an InfluxDB client and staggers flushes to influx to
 * avoid manual flushing handling.
 *
 * `stop()` is implemented to properly close the InfluxDB, flushing pending writes
 *
 * If `INFLUXDB_TOKEN` is not set in the environment, the module is disabled and all
 * calls will result in no-ops, with a warning logged at startup.
 */
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
      logger.info("[InfluxDB] Client initialized successfully")
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

  /**
   * Writes a point to InfluxDB. If the client is not initialized, this method does nothing.
   * A new call to `flush()` will be scheduled, but the actual flush will be throttled to at most once every 5 seconds,
   * to batch multiple writes.
   *
   * @param point The point to write to InfluxDB
   */
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

export const influxClient = new InfluxClient()
