import { type AppRouter, TRPC_PATH } from "@polinetwork/backend"
import type { TRPCClient } from "@trpc/client"
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client"
import { SuperJSON } from "superjson"

import { env } from "./env"
import { logger } from "./logger"

const url = `http://${env.BACKEND_URL}${TRPC_PATH}`
export const api = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url, transformer: SuperJSON })] })

export type Role = Parameters<TRPCClient<AppRouter>["tg"]["permissions"]["setRole"]["query"]>[0]["role"]

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
