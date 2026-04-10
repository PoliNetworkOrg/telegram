import { Point } from "@influxdata/influxdb-client"
import { Composer, type Context, type MiddlewareFn, type MiddlewareObj } from "grammy"
import { modules } from ".."
import type { TelemetryContextFlavor } from "./types"

/**
 * Middleware to initialize the telemetry point for each update and measure the total duration of the update handling.
 * It adds a `point` property to the context, which is an instance of `Point` from the InfluxDB client, and a `stackTimes`
 * property, which is an object that can be used by other middleware to store the start time of their execution. The
 * middleware tags the point with the type of the update (e.g. "message", "callback_query", etc.) and adds an integer
 * field with the total duration of the update handling in milliseconds.
 *
 * Writes the point to InfluxDB at the end of the middleware stack, so it will include any additional tags or fields
 * added by other middleware.
 */
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

/**
 * A base class for middleware that want to track the duration of their execution in the telemetry. It provides a `composer` property
 * that can be used to build the middleware stack, and it automatically measures the time taken by the middleware stack and adds it as a field to the telemetry point.
 * The `stackName` parameter is used to differentiate the duration fields of different middleware stacks. For example,
 * if you have a middleware stack for handling commands and another for handling messages, you can use `stackName = "command"`
 * for the first and `stackName = "message"` for the second, and the telemetry points will have fields `command_duration` and `message_duration` respectively.
 */
export abstract class TrackedMiddleware<C extends TelemetryContextFlavor<Context>> implements MiddlewareObj<C> {
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
    return this.trackingComposer.middleware()
  }
}

/**
 * Utility middleware to measure the duration of a middleware stack or a specific operation. It adds an integer field to
 * the telemetry point with the specified name, representing the duration in milliseconds.
 * ### Important
 * This only makes sense if the middleware is used within a forked flow, as it relies on awaiting the `next()` function
 * to measure the duration of the subsequent operations. If used in a non-forked flow, it will measure the duration of
 * the entire middleware stack, which might not be the intended behavior.
 *
 * @example
 * ```ts
 * // In this example, the `measureForkDuration` middleware will measure the time taken by both `myMiddleware` and
 * // `anotherMiddleware`, and add a field `my_operation` to the telemetry point with the duration in milliseconds.
 * // `another_operation` will just measure the time taken by `anotherMiddleware`.
 * composer
 *   .fork()
 *   .use(measureForkDuration("my_operation")),
 *   .use(myMiddleware)
 *   .fork()
 *   .use(measureForkDuration("another_operation"))
 *   .use(anotherMiddleware)
 * ```
 */
export function measureForkDuration<C extends TelemetryContextFlavor<Context>>(name: string): MiddlewareFn<C> {
  return async (ctx, next) => {
    const start = Date.now()
    await next()
    const duration = Date.now() - start
    ctx.point.intField(name, duration)
  }
}
