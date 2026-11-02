import type { TokenSource } from "@polinetwork/auth-kit"
import type { Logger } from "pino"

/** The part of a socket.io client socket this needs. */
export type ReconnectingSocket = {
  /** False once socket.io has given up and will not reconnect by itself. */
  readonly active: boolean
  connect(): unknown
  disconnect(): unknown
  on(event: "connect", listener: () => void): unknown
  on(event: "disconnect", listener: (reason: string) => void): unknown
  on(event: "connect_error", listener: (error: Error) => void): unknown
}

export type SocketTokenAuthOptions = {
  logger: Pick<Logger, "info" | "warn" | "error">
  /** First retry delay; doubled on each failure. Default 1 s. */
  minDelayMs?: number
  /** Default 60 s. */
  maxDelayMs?: number
  /** A connection that lasted this long resets the backoff. Default 60 s. */
  stableAfterMs?: number
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/**
 * Authenticates the bot's socket with its service token (RFC v3 §8.3) and keeps it connected:
 *
 * - every (re)connection sends a fresh token in the handshake's `auth.token`;
 * - the backend disconnects the socket when the token expires, and socket.io does not reconnect
 *   after a server-side disconnect, so this does; the token source renews a token that is about
 *   to expire, and keeps a newer one it already has (it may be all there is during an IdP outage);
 * - a rejected handshake (`connect_error` with the socket inactive) is not retried by socket.io
 *   either: the backend refused the token, so it is dropped and the connection retried with backoff.
 *
 * Transport errors are left to socket.io's own reconnection, which calls {@link auth} again.
 */
export class SocketTokenAuth {
  private failures = 0
  private connectedAt: number | null = null
  private timer: unknown = null
  private stopped = false
  private socket: ReconnectingSocket | null = null
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void

  constructor(
    private readonly tokens: TokenSource,
    private readonly options: SocketTokenAuthOptions
  ) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  /** The socket.io `auth` option: called on every connection attempt. */
  readonly auth = (cb: (data: object) => void) => {
    if (this.stopped) return
    this.tokens.getToken().then(
      (token) => {
        if (!this.stopped) cb({ token })
      },
      (error: unknown) => {
        if (this.stopped) return
        this.options.logger.error({ error }, "[WS] cannot get a service token")
        // Without a handshake the attempt would hang; abort it and try again later.
        this.socket?.disconnect()
        this.retry(false)
      }
    )
  }

  attach(socket: ReconnectingSocket) {
    this.socket = socket
    socket.on("connect", () => {
      this.connectedAt = this.now()
    })
    socket.on("disconnect", (reason) => {
      if (this.connectedAt !== null && this.now() - this.connectedAt >= (this.options.stableAfterMs ?? 60_000))
        this.failures = 0
      this.connectedAt = null
      if (reason !== "io server disconnect") return
      this.options.logger.info("[WS] disconnected by the server, reconnecting")
      this.retry(false)
    })
    socket.on("connect_error", (error) => {
      if (socket.active) return
      this.options.logger.warn({ error: error.message }, "[WS] handshake rejected, retrying with a new token")
      this.retry(true)
    })
  }

  stop() {
    this.stopped = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }

  /** Reconnects: at once the first time, then with exponential backoff until a connection holds. */
  private retry(dropToken: boolean) {
    if (dropToken) this.tokens.invalidate()
    if (this.stopped || this.timer !== null) return
    const min = this.options.minDelayMs ?? 1_000
    const delay = this.failures === 0 ? 0 : Math.min(min * 2 ** (this.failures - 1), this.options.maxDelayMs ?? 60_000)
    this.failures++
    this.timer = this.setTimer(() => {
      this.timer = null
      if (!this.stopped) this.socket?.connect()
    }, delay)
  }
}
