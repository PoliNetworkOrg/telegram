import { idpEndpoints, type ServiceTokenSourceOptions } from "@polinetwork/auth-kit"

type JWK = ServiceTokenSourceOptions["privateKey"]

/** What the bot may do with its service token (RFC v3 §6.2, §7.3). */
export const BOT_SCOPES = [
  "backend:tg:read",
  "backend:tg:ingest",
  "backend:tg:groups:sync",
  "backend:tg:audit",
  "backend:tg:act-as",
  "backend:tg:events",
] as const

export type IdpEnv = {
  IDP_PUBLIC_URL: string
  IDP_INTERNAL_URL?: string
  OAUTH_BACKEND_RESOURCE_URI: string
  OAUTH_BOT_CLIENT_ID: string
  OAUTH_BOT_PRIVATE_JWK: string
}

export type IdpConfig = {
  clientId: string
  privateKey: JWK
  tokenUrl: string
  tokenAudience: string
  resource: string
  scopes: readonly string[]
}

/** The bot's token configuration (RFC v3 §10.1). */
export function parseIdpConfig(env: IdpEnv): IdpConfig {
  let privateKey: unknown
  try {
    privateKey = JSON.parse(env.OAUTH_BOT_PRIVATE_JWK)
  } catch {
    // Never echo the value: it is the private key.
    throw new Error("OAUTH_BOT_PRIVATE_JWK is not valid JSON")
  }
  if (typeof privateKey !== "object" || privateKey === null || Array.isArray(privateKey))
    throw new Error("OAUTH_BOT_PRIVATE_JWK must be a JWK object")

  const endpoints = idpEndpoints({ publicUrl: env.IDP_PUBLIC_URL, internalUrl: env.IDP_INTERNAL_URL })
  return {
    clientId: env.OAUTH_BOT_CLIENT_ID,
    privateKey: privateKey as JWK,
    tokenUrl: endpoints.tokenUrl,
    tokenAudience: endpoints.tokenAudience,
    resource: env.OAUTH_BACKEND_RESOURCE_URI,
    scopes: BOT_SCOPES,
  }
}
