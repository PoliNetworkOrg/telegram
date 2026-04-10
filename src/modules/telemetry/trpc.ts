import { Point } from "@influxdata/influxdb-client"
import type { AppRouter } from "@polinetwork/backend"
import type { TRPCLink } from "@trpc/client"
import { observable } from "@trpc/server/observable"
import { influxClient } from "./influxdb"

/**
 * TRPC link that records telemetry for each call, including duration, success status, and error codes.
 */
export const trpcTelemetryLink: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) =>
    observable((observer) => {
      const start = Date.now()
      const point = new Point("backend_trpc_call").tag("path", op.path).tag("type", op.type).timestamp(new Date(start))

      const sub = next(op).subscribe({
        next(value) {
          observer.next(value)
        },
        error(err) {
          point
            .intField("duration_ms", Date.now() - start)
            .booleanField("success", false)
            .stringField("error_name", err.name)
            .stringField("error_message", err.message)
          influxClient.writePoint(point)
          observer.error(err)
        },
        complete() {
          point.intField("duration_ms", Date.now() - start).booleanField("success", true)
          influxClient.writePoint(point)
          observer.complete()
        },
      })

      return () => sub.unsubscribe()
    })
