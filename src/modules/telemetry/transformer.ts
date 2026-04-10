import { Point } from "@influxdata/influxdb-client"
import type { Transformer } from "grammy"
import { modules } from ".."

/**
 * A transformer to track the duration and success of API calls made by the bot.
 * It creates a telemetry point for each API call, tags it with the method name,
 * and adds fields for the duration of the call in milliseconds, whether it was
 * successful, and the error code if it was not successful. The point is then
 * written to InfluxDB.
 */
export function tgApiTelemetry(): Transformer {
  return async (prev, method, payload, signal) => {
    const point = new Point("tg_api_call").tag("method", method)
    const start = Date.now()
    point.timestamp(new Date(start))
    const res = await prev(method, payload, signal)
    point.intField("duration_ms", Date.now() - start)
    if (res.ok) {
      point.booleanField("success", true)
    } else {
      point.booleanField("success", false).stringField("error_code", res.error_code.toString())
    }
    modules.get("influx").writePoint(point)
    return res
  }
}
