import { serviceTokenSource, type TokenSource } from "@polinetwork/auth-kit"
import { type AppRouter, TRPC_PATH } from "@polinetwork/backend"
import { createTRPCClient, httpBatchLink, type TRPCClient, TRPCClientError } from "@trpc/client"
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server"
import type { User } from "grammy/types"
import { SuperJSON } from "superjson"

import { env } from "./env"
import { parseIdpConfig } from "./idp/config"
import { authenticatedFetch } from "./idp/fetch"
import { logger } from "./logger"
import { trpcTelemetryLink } from "./modules/telemetry/trpc"

const url = `http://${env.BACKEND_URL}${TRPC_PATH}`

export type Backend = TRPCClient<AppRouter>
export type ApiOutput = inferRouterOutputs<AppRouter>
export type ApiInput = inferRouterInputs<AppRouter>

/** The bot's IdP client configuration; null while it still calls the backend anonymously. */
export const idpConfig = parseIdpConfig(env)

/** The `telegram-bot` service token (RFC v3 §10.1), cached and renewed at half its lifetime. */
export const serviceTokens: TokenSource | null = idpConfig
  ? serviceTokenSource({
      ...idpConfig,
      onError: (error) => logger.warn({ error }, "[IDP] service token renewal failed, using the cached token"),
    })
  : null

function createBackendClient(tokens: TokenSource | null, actorTelegramId: number | null = null): Backend {
  return createTRPCClient<AppRouter>({
    links: [
      trpcTelemetryLink,
      httpBatchLink({
        url,
        transformer: SuperJSON,
        fetch: tokens ? authenticatedFetch(tokens, actorTelegramId) : undefined,
      }),
    ],
  })
}

/**
 * Acts as the bot itself: background work (storage flush, ban-all, cron, startup) and every lookup
 * the backend grants only to the service (RFC v3 §8.1). Anonymous when the IdP is not configured.
 */
export const serviceBackend: Backend = createBackendClient(serviceTokens)

/**
 * Always anonymous. Only for the procedures the RFC removes and the backend refuses to token
 * callers (`tg.permissions.*`, `tg.link.link`, `tg.auditLog.create`, `test.dbQuery`), which keep
 * working while the backend allows legacy calls (RFC v3 §13).
 */
export const legacyBackend: Backend = serviceTokens ? createBackendClient(null) : serviceBackend

/**
 * Acts for a Telegram user through `X-PN-Actor` (RFC v3 §6.3). The backend accepts such an actor
 * only on `tg.access.resolve`, `tg.grants.interrupt` and `tg.auditLog.getById`, and checks the
 * person's IdP permissions there.
 */
export function backendAs(telegramId: number): Backend {
  return serviceTokens ? createBackendClient(serviceTokens, telegramId) : serviceBackend
}

/** One client per update: acting for its human sender, otherwise the service (RFC v3 §10.1). */
export function backendFor(from: User | undefined): Backend {
  return from && !from.is_bot ? backendAs(from.id) : serviceBackend
}

/** Startup check; with a token it also proves the IdP issues one the backend accepts. */
export async function backendHealthCheck(botId: number) {
  try {
    if (serviceTokens) await serviceBackend.tg.access.resolve.query({ telegramIds: [botId] })
    else await legacyBackend.test.dbQuery.query({ dbName: "tg" })
    logger.info(`[BACKEND] connected${serviceTokens ? " with the IdP service token" : ""}`)
  } catch (err) {
    if (err instanceof TRPCClientError && err.message.startsWith("fetch failed"))
      logger.error(`[BACKEND] can't connect`)
    else logger.error({ err }, `[BACKEND] error during the startup check`)
  }
}
