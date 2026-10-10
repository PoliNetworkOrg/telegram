import { ACTOR_HEADER, formatTelegramActor, type TokenSource } from "@polinetwork/auth-kit"

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * A fetch that sends the bot's service token and, when acting for a Telegram user, the
 * `X-PN-Actor` header (RFC v3 §6.3). A `401` means the backend no longer accepts the cached token
 * (expired, revoked or rotated keys): the token is dropped and the request retried once.
 */
export function authenticatedFetch(tokens: TokenSource, actorTelegramId: number | null, baseFetch: Fetch = fetch) {
  const actor = actorTelegramId === null ? null : formatTelegramActor(actorTelegramId)

  const send = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set("Authorization", `Bearer ${await tokens.getToken()}`)
    if (actor) headers.set(ACTOR_HEADER, actor)
    else headers.delete(ACTOR_HEADER)
    const timeout = AbortSignal.timeout(10_000)
    const suppliedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = suppliedSignal ? AbortSignal.any([suppliedSignal, timeout]) : timeout
    return baseFetch(input, { ...init, headers, signal })
  }

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await send(input, init)
    if (response.status !== 401) return response
    await response.body?.cancel().catch(() => {})
    tokens.invalidate()
    return send(input, init)
  }
}
