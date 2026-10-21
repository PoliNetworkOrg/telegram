import { describe, expect, it, vi } from "vitest"
import { ModuleCoordinator } from "@/lib/modules"
import { TgLogger } from "@/modules/tg-logger"
import type { ModuleShared } from "@/utils/types"

vi.hoisted(() => {
  process.env.BOT_TOKEN = "test-token"
  process.env.BACKEND_URL = "backend.test"
  process.env.NODE_ENV = "development"
  process.env.IDP_PUBLIC_URL = "https://auth.test"
  process.env.OAUTH_BACKEND_RESOURCE_URI = "https://backend.test"
  process.env.OAUTH_BOT_CLIENT_ID = "bot-id"
  process.env.OAUTH_BOT_PRIVATE_JWK = JSON.stringify({ alg: "EdDSA", kid: "test" })
})

vi.mock("@/backend", () => ({ serviceBackend: {}, backendAs: vi.fn(), backendFor: vi.fn() }))

vi.mock("@/lib/redis-fallback-adapter", () => ({
  RedisFallbackAdapter: class {},
}))
vi.mock("@/modules", () => ({ modules: {} }))
vi.mock("@/redis", () => ({ redis: {} }))

describe("TgLogger flood protection", () => {
  it("suppresses Telegram metadata calls after the automatic-log gate closes", async () => {
    const getChat = vi.fn().mockResolvedValue({
      id: -1001,
      type: "supergroup",
      title: "Test group",
      invite_link: "https://t.me/example",
    })
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 })
    const tgLogger = new TgLogger(-10099, {
      actionRequired: 10,
      adminActions: 5,
      autoModeration: 7,
      banAll: 13,
      deletedMessages: 130,
      exceptions: 3,
      grants: 402,
      groupManagement: 33,
    })
    const coordinator = new ModuleCoordinator({ tgLogger }, async () => {
      return {
        api: { getChat, sendMessage },
        botInfo: { id: 7, is_bot: true, first_name: "Bot", username: "test_bot" },
      } as unknown as ModuleShared
    })
    await coordinator.ready()

    const action = {
      action: "BAN" as const,
      from: { id: 7, is_bot: true, first_name: "Bot" },
      basis: "automatic" as const,
      target: { id: 42, is_bot: false, first_name: "Target" },
      chat: { id: -1001, type: "supergroup" as const, title: "Test group" },
    }

    await tgLogger.moderationAction(action)
    await tgLogger.moderationAction(action)

    expect(getChat).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
