import { Point } from "@influxdata/influxdb-client"
import { Composer, type Context, type MiddlewareFn, type MiddlewareObj } from "grammy"
import { modules } from ".."
import type { TelemetryContextFlavor } from "./types"

export function telemetry<C extends TelemetryContextFlavor<Context>>(): MiddlewareFn<C> {
  return async (ctx, next) => {
    const now = new Date()
    ctx.point = new Point("tg_update").timestamp(now)
    ctx.stackTimes = {}
    // The keys in the update object represent the type of the update, e.g. "message", "callback_query", etc.
    // `update_id` is always present and does not represent the type of the update, so we filter it out.
    const updates = Object.keys(ctx.update).filter((key) => key !== "update_id")
    for (const update of updates) {
      ctx.point.tag("update_type", update)
    }
    await next()
    const duration = Date.now() - now.getTime()
    ctx.point.intField("duration", duration)
    modules.get("influx").writePoint(ctx.point)
  }
}

export class TrackedMiddleware<C extends TelemetryContextFlavor<Context>> implements MiddlewareObj<C> {
  private trackingComposer = new Composer<C>()
  protected composer = new Composer<C>()

  constructor(stackName: string) {
    this.trackingComposer
      .use(async (ctx, next) => {
        ctx.stackTimes[stackName] = Date.now()
        await next()
      })
      .use(this.composer)
      .use(async (ctx, next) => {
        const startTime = ctx.stackTimes[stackName]
        if (startTime) {
          const duration = Date.now() - startTime
          ctx.point.intField(`${stackName}_duration`, duration)
        }
        await next()
      })
  }

  middleware() {
    return this.composer.middleware()
  }
}

export function measureDuration<C extends TelemetryContextFlavor<Context>>(name: string): MiddlewareFn<C> {
  return async (ctx, next) => {
    const start = Date.now()
    await next()
    const duration = Date.now() - start
    ctx.point.intField(name, duration)
  }
}
