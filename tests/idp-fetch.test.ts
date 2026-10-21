import type { TokenSource } from "@polinetwork/auth-kit"
import { describe, expect, it, vi } from "vitest"
import { BOT_SCOPES, parseIdpConfig } from "@/idp/config"
import { authenticatedFetch } from "@/idp/fetch"

const tokens = () => ({ getToken: vi.fn(async () => "signed-token"), invalidate: vi.fn() }) satisfies TokenSource

describe("service and actor requests", () => {
  it("concurrent actor clients never mix identity headers", async () => {
    const calls: Headers[] = []
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(new Headers(init?.headers))
      return new Response("ok")
    })
    await Promise.all([
      authenticatedFetch(tokens(), 11, transport)("https://backend.test/a"),
      authenticatedFetch(tokens(), 22, transport)("https://backend.test/b"),
    ])
    expect(calls.map((headers) => headers.get("X-PN-Actor"))).toEqual(["telegram:11", "telegram:22"])
    expect(calls.every((headers) => headers.get("Authorization") === "Bearer signed-token")).toBe(true)
  })

  it("service requests remove actor headers while preserving other Request headers", async () => {
    const transport = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get("X-PN-Actor")).toBeNull()
      expect(headers.get("content-type")).toBe("application/json")
      return new Response("ok")
    })
    await authenticatedFetch(
      tokens(),
      null,
      transport
    )(
      new Request("https://backend.test", {
        headers: { "X-PN-Actor": "telegram:99", "content-type": "application/json" },
      })
    )
  })

  it("invalidates and retries once on 401, with the same actor and body", async () => {
    const source = tokens()
    source.getToken.mockResolvedValueOnce("old").mockResolvedValue("new")
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("again", { status: 401 }))
    const response = await authenticatedFetch(
      source,
      42,
      transport
    )("https://backend.test", { method: "POST", body: "mutation" })
    expect(response.status).toBe(401)
    expect(source.invalidate).toHaveBeenCalledOnce()
    expect(transport).toHaveBeenCalledTimes(2)
    expect(new Headers(transport.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer new")
    expect(new Headers(transport.mock.calls[1]?.[1]?.headers).get("X-PN-Actor")).toBe("telegram:42")
    expect(transport.mock.calls[1]?.[1]?.body).toBe("mutation")
  })

  it("does not retry forbidden or failed mutations", async () => {
    const source = tokens()
    const transport = vi.fn(async () => new Response("forbidden", { status: 403 }))
    await authenticatedFetch(source, 42, transport)("https://backend.test")
    expect(transport).toHaveBeenCalledOnce()
    expect(source.invalidate).not.toHaveBeenCalled()
  })
})

describe("IdP deployment configuration", () => {
  it("keeps the public assertion audience when using an internal token transport", () => {
    const config = parseIdpConfig({
      IDP_PUBLIC_URL: "https://auth.test",
      IDP_INTERNAL_URL: "http://auth:3000",
      OAUTH_BACKEND_RESOURCE_URI: "https://backend.test",
      OAUTH_BOT_CLIENT_ID: "bot-id",
      OAUTH_BOT_PRIVATE_JWK: JSON.stringify({ alg: "EdDSA", kid: "test" }),
    })
    expect(config.tokenUrl).toBe("http://auth:3000/api/auth/oauth2/token")
    expect(config.tokenAudience).toBe("https://auth.test/api/auth/oauth2/token")
    expect(config.scopes).toEqual(BOT_SCOPES)
  })

  it("never echoes malformed private key material", () => {
    const config = {
      IDP_PUBLIC_URL: "https://auth.test",
      OAUTH_BACKEND_RESOURCE_URI: "https://backend.test",
      OAUTH_BOT_CLIENT_ID: "bot-id",
      OAUTH_BOT_PRIVATE_JWK: "SECRET-INVALID-JSON",
    }
    expect(() => parseIdpConfig(config)).toThrow("OAUTH_BOT_PRIVATE_JWK is not valid JSON")
  })
})
