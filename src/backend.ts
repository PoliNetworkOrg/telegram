import { type AppRouter, TRPC_PATH } from "@polinetwork/backend"
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client"
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server"
import { observable } from "@trpc/server/observable"
import { SuperJSON } from "superjson"

import { env } from "./env"
import { logger } from "./logger"
import { BotAttributes, botMetrics } from "./telemetry"

const url = `http://${env.BACKEND_URL}${TRPC_PATH}`
export const api = createTRPCClient<AppRouter>({
  links: [
    // Custom link that measures tRPC call duration
    () =>
      ({ op, next }) => {
        const start = performance.now()
        return observable((observer) => {
          const sub = next(op).subscribe({
            next(value) {
              botMetrics.trpcDuration.record(performance.now() - start, {
                [BotAttributes.TRPC_PROCEDURE]: op.path,
                [BotAttributes.TRPC_SUCCESS]: true,
              })
              observer.next(value)
            },
            error(err) {
              botMetrics.trpcDuration.record(performance.now() - start, {
                [BotAttributes.TRPC_PROCEDURE]: op.path,
                [BotAttributes.TRPC_SUCCESS]: false,
              })
              observer.error(err)
            },
            complete() {
              observer.complete()
            },
          })
          return sub.unsubscribe
        })
      },
    httpBatchLink({ url, transformer: SuperJSON }),
  ],
})

export type ApiOutput = inferRouterOutputs<AppRouter>
export type ApiInput = inferRouterInputs<AppRouter>

export async function apiTestQuery() {
  try {
    await api.test.dbQuery.query({ dbName: "tg" })
    logger.info(`[BACKEND] connected`)
  } catch (err) {
    if (err instanceof TRPCClientError && err.message.startsWith("fetch failed"))
      logger.error(`[BACKEND] can't connect`)
    else logger.error({ err }, `[BACKEND] error during test query`)
  }
}
