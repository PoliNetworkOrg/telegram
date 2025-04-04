import { TRPC_PATH, type AppRouter } from "@polinetwork/backend"
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client"
import { logger } from "./logger"

const url = "http://" + process.env.BACKEND_URL + TRPC_PATH
export const api = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url })] })

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
