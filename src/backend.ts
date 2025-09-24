import { type AppRouter, TRPC_PATH } from "@polinetwork/backend"
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client"
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server"
import { SuperJSON } from "superjson"

import { env } from "./env"
import { logger } from "./logger"

const url = `http://${env.BACKEND_URL}${TRPC_PATH}`
export const api = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url, transformer: SuperJSON })] })

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
