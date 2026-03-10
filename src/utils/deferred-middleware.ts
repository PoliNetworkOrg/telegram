import type { Context, MiddlewareFn } from "grammy"
import { logger } from "@/logger"
import { BotAttributes, recordException } from "@/telemetry"

/**
 * Defer middleware execution as to not halt the execution of the main stack.
 *
 * Use this to run middlewares that can be executed asynchronously with no particular order.
 * @param middleware The middleware to be executed outside of the main middleware stack.
 */
export function defer<C extends Context>(middleware: (ctx: C) => Promise<void>): MiddlewareFn<C> {
  return (context, next) => {
    void middleware(context).catch((error) => {
      recordException(error, {
        name: "bot.deferred.error",
        attributes: { [BotAttributes.IMPORTANCE]: "high" },
      })
      logger.error({ error }, "Deferred middleware failed")
    })
    return next()
  }
}
