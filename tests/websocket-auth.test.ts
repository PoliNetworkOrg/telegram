import type { TokenSource } from "@polinetwork/auth-kit"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type ReconnectingSocket, SocketTokenAuth } from "@/modules/websocket-auth"

class Socket {
  active = false
  connect = vi.fn()
  disconnect = vi.fn()
  listeners = new Map<string, (...args: never[]) => void>()
  on(event: string, listener: (...args: never[]) => void) {
    this.listeners.set(event, listener)
  }
  emit(event: string, arg?: string | Error) {
    this.listeners.get(event)?.(...((arg === undefined ? [] : [arg]) as never[]))
  }
}
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
const tokens = () => ({ getToken: vi.fn(async () => "current-token"), invalidate: vi.fn() }) satisfies TokenSource

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("socket service authentication", () => {
  it("reads the token on every handshake", async () => {
    const source = tokens()
    const auth = new SocketTokenAuth(source, { logger })
    const cb = vi.fn()
    auth.auth(cb)
    await Promise.resolve()
    source.getToken.mockResolvedValue("renewed-token")
    auth.auth(cb)
    await Promise.resolve()
    expect(cb.mock.calls).toEqual([[{ token: "current-token" }], [{ token: "renewed-token" }]])
  })

  it("reconnects after server expiry, letting the source retain a newer cached token", async () => {
    const source = tokens()
    const socket = new Socket()
    const auth = new SocketTokenAuth(source, { logger })
    auth.attach(socket as ReconnectingSocket)
    socket.emit("disconnect", "io server disconnect")
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.connect).toHaveBeenCalledOnce()
    expect(source.invalidate).not.toHaveBeenCalled()
    auth.stop()
  })

  it("backs off rejected handshakes and cancels reconnection on shutdown", async () => {
    const source = tokens()
    const socket = new Socket()
    const auth = new SocketTokenAuth(source, { logger })
    auth.attach(socket as ReconnectingSocket)
    socket.emit("connect_error", new Error("unauthorized"))
    await vi.advanceTimersByTimeAsync(0)
    socket.emit("connect_error", new Error("unauthorized"))
    await vi.advanceTimersByTimeAsync(999)
    expect(socket.connect).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(socket.connect).toHaveBeenCalledTimes(2)
    socket.emit("connect_error", new Error("unauthorized"))
    auth.stop()
    await vi.runAllTimersAsync()
    expect(socket.connect).toHaveBeenCalledTimes(2)
    expect(source.invalidate).toHaveBeenCalledTimes(3)
  })

  it("leaves transport reconnection to socket.io", async () => {
    const source = tokens()
    const socket = new Socket()
    socket.active = true
    const auth = new SocketTokenAuth(source, { logger })
    auth.attach(socket as ReconnectingSocket)
    socket.emit("connect_error", new Error("transport error"))
    socket.emit("disconnect", "transport close")
    await vi.runAllTimersAsync()
    expect(socket.connect).not.toHaveBeenCalled()
    expect(source.invalidate).not.toHaveBeenCalled()
    auth.stop()
  })

  it("does not complete an in-flight handshake after stopping", async () => {
    let finish = (_token: string) => {}
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    const auth = new SocketTokenAuth({ getToken: () => pending, invalidate: vi.fn() }, { logger })
    const cb = vi.fn()
    auth.auth(cb)
    auth.stop()
    finish("token")
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
  })
})
