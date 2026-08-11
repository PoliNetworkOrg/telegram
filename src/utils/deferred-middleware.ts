import type { Context, MiddlewareFn } from "grammy"
import { logger } from "@/logger"

/**
 * Defer middleware execution as to not halt the execution of the main stack.
 *
 * Use this to run middlewares that can be executed asynchronously with no particular order.
 *
 * # Important
 * Middlewares wrapped with `defer` will be executed completely outside of grammy's stack,
 * there won't be any catching or measurements from telemetry, so make sure to handle any possible
 * error inside the middleware and log it properly, otherwise it will be lost.
 * @param middleware The middleware to be executed outside of the main middleware stack.
 */
export function defer<C extends Context>(middleware: (ctx: C) => Promise<void>): MiddlewareFn<C> {
  return (context, next) => {
    void middleware(context as C).catch((error) => {
      logger.error({ error }, "[Defer] Error in deferred middleware:")
    })
    return next()
  }
}
