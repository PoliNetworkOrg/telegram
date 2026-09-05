import { Point } from "@influxdata/influxdb-client"
import { Api, Context as GrammyContext } from "grammy"
import type { Update } from "grammy/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { logger } from "@/logger"
import { CampaignSpamGuard } from "@/middlewares/campaign-spam"
import { CampaignActorOperationBusyError } from "@/middlewares/campaign-spam/reputation"
import { campaignSpamReputation } from "@/middlewares/campaign-spam/service"
import type { TelemetryContextFlavor } from "@/modules/telemetry"
import type { Context } from "@/utils/types"

vi.mock("@/env", () => ({ env: { BOT_TOKEN: "test-token-for-campaign-fingerprints-123456" } }))
vi.mock("@/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/backend", () => ({
  api: {
    tg: {
      permissions: { getRoles: { query: vi.fn().mockResolvedValue({ roles: [] }) } },
      grants: { checkUser: { query: vi.fn().mockResolvedValue({ isGranted: false }) } },
      auditLog: { getById: { query: vi.fn().mockResolvedValue([]) } },
    },
  },
}))
vi.mock("@/modules", () => ({ modules: {} }))
vi.mock("@/modules/moderation", () => ({ Moderation: {} }))
vi.mock("@/modules/telemetry", async () => import("@/modules/telemetry/middleware"))
vi.mock("@/middlewares/campaign-spam/review", () => ({
  campaignSpamReviewKeyboard: vi.fn(),
  campaignSpamReviewText: vi.fn(),
}))
vi.mock("@/middlewares/campaign-spam/service", () => ({
  campaignSpamReputation: {
    inspectJoin: vi.fn(),
    runActorOperation: vi.fn(),
    recordJoin: vi.fn(),
    markPending: vi.fn(),
    clearPending: vi.fn(),
  },
}))

const user = { id: 42, is_bot: false, first_name: "Member" }
const chat = { id: -1001, type: "supergroup" as const, title: "Group" }
const bot = {
  id: 7,
  is_bot: true as const,
  first_name: "Bot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
}

function joinContext() {
  const update: Update = { update_id: 1, chat_join_request: { chat, from: user, user_chat_id: 42, date: 1 } }
  const ctx = new GrammyContext(update, new Api("test"), bot) as TelemetryContextFlavor<Context>
  ctx.point = new Point("test")
  ctx.stackTimes = {}
  vi.spyOn(ctx.api, "approveChatJoinRequest").mockResolvedValue(true)
  vi.spyOn(ctx.api, "restrictChatMember").mockResolvedValue(true)
  return ctx
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(campaignSpamReputation.inspectJoin).mockResolvedValue({
    deniedUser: false,
    confirmedProfile: false,
    profileAuthors: 0,
    riskyProfile: false,
  })
})

describe("always-active campaign join gate", () => {
  it("approves and restricts ordinary joins without feature environment settings", async () => {
    const ctx = joinContext()
    vi.mocked(campaignSpamReputation.runActorOperation).mockImplementation(async (_actor, operation) =>
      operation({ assertOwned: vi.fn().mockResolvedValue(undefined) } as never)
    )
    await new CampaignSpamGuard().middleware()(ctx, async () => {})
    expect(ctx.api.approveChatJoinRequest).toHaveBeenCalledWith(chat.id, user.id)
    expect(ctx.api.restrictChatMember).toHaveBeenCalledWith(
      chat.id,
      user.id,
      expect.objectContaining({ can_send_messages: true, can_send_photos: false }),
      expect.objectContaining({ use_independent_chat_permissions: true })
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: user.id, pendingState: "first_post" }),
      "[CampaignSpam] Join approved and restricted"
    )
  })

  it("resolves a join request when the actor lease is busy", async () => {
    const ctx = joinContext()
    vi.mocked(campaignSpamReputation.runActorOperation).mockRejectedValue(new CampaignActorOperationBusyError())
    await new CampaignSpamGuard().middleware()(ctx, async () => {})
    expect(ctx.api.approveChatJoinRequest).toHaveBeenCalledWith(chat.id, user.id)
    expect(ctx.api.restrictChatMember).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "approved_concurrent_operation" }),
      "[CampaignSpam] Join admission fallback"
    )
  })

  it("logs failed fallback approval as a failure", async () => {
    const ctx = joinContext()
    vi.mocked(ctx.api.approveChatJoinRequest).mockRejectedValue(new Error("Telegram unavailable"))
    vi.mocked(campaignSpamReputation.runActorOperation).mockRejectedValue(new CampaignActorOperationBusyError())
    await new CampaignSpamGuard().middleware()(ctx, async () => {})
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "approval_failed" }),
      "[CampaignSpam] Join admission fallback"
    )
  })
})
