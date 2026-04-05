import type { Point } from "@influxdata/influxdb-client"
import type { Context } from "grammy"

export type TelemetryContextFlavor<C extends Context> = C & {
  point: Point
  stackTimes: Record<string, number>
}
