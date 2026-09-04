import type { Filter } from "grammy"
import type { ChatPermissions, Message, User } from "grammy/types"
import { api } from "@/backend"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { measureForkDuration, type TelemetryContextFlavor, TrackedMiddleware } from "@/modules/telemetry"
import { redis } from "@/redis"
import { RestrictPermissions } from "@/utils/chat"
import { duration } from "@/utils/duration"
import { getText } from "@/utils/messages"
import { throttle } from "@/utils/throttle"
import type { Context } from "@/utils/types"
import { type CampaignMessageSignals, classifyCampaignMessage, extractCampaignSignals } from "./classifier"
import { type CampaignActor, type CampaignJoinReputation, type CampaignRedis, CampaignReputation } from "./reputation"
import { campaignSpamConfig } from "./runtime-config"

const NETWORK_PRIVILEGED_ROLES = new Set(["president", "owner", "direttivo"])
const FIRST_POST_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
} satisfies ChatPermissions

type MessageContext<C extends Context> = Filter<
  C,
  "message:text" | "message:caption" | "edited_message:text" | "edited_message:caption"
>

const reportDependencyError = throttle((error: unknown, operation: string) => {
  logger.error({ error, operation }, "[CampaignSpam] Dependency error; failing open")
}, 60_000)

function actorFromUser(user: User): CampaignActor {
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
  }
}

function inlineKeyboardSignals(message: Message): { buttonUrls: string[]; hasInlineKeyboard: boolean } {
  if (!("reply_markup" in message) || !message.reply_markup) {
    return { buttonUrls: [], hasInlineKeyboard: false }
  }
  const rows = message.reply_markup.inline_keyboard
  return {
    hasInlineKeyboard: rows.some((row) => row.length > 0),
    buttonUrls: rows.flatMap((row) =>
      row.flatMap((button) => {
        if ("url" in button && button.url) return [button.url]
        if ("login_url" in button && button.login_url) return [button.login_url.url]
        if ("web_app" in button && button.web_app) return [button.web_app.url]
        return []
      })
    ),
  }
}

function messageSignals(message: Message): CampaignMessageSignals {
  const text = getText(message).text ?? ""
  const entities =
    "entities" in message ? message.entities : "caption_entities" in message ? message.caption_entities : []
  const inlineKeyboard = inlineKeyboardSignals(message)
  return extractCampaignSignals({
    text,
    entityTypes: entities?.map((entity) => entity.type),
    buttonUrls: inlineKeyboard.buttonUrls,
    hasInlineKeyboard: inlineKeyboard.hasInlineKeyboard,
    viaBotId: message.via_bot?.id,
  })
}

export class CampaignSpamGuard<C extends TelemetryContextFlavor<Context>> extends TrackedMiddleware<C> {
  private readonly reputation = new CampaignReputation(redis as CampaignRedis, campaignSpamConfig)
  private readonly localBanAllClaims = new Set<number>()

  constructor() {
    super("campaign_spam")
    if (campaignSpamConfig.mode === "off") return

    this.composer
      .on(["message:text", "message:caption", "edited_message:text", "edited_message:caption"])
      .fork()
      .use(measureForkDuration("campaign_spam_message_duration"))
      .use((ctx) => this.handleMessage(ctx))

    this.composer
      .on("chat_join_request")
      .fork()
      .use(measureForkDuration("campaign_spam_join_request_duration"))
      .use((ctx) => this.handleJoinRequest(ctx))

    this.composer
      .on("chat_member")
      .fork()
      .use((ctx) => this.handleMemberUpdate(ctx))
  }

  private async isMessageExempt(ctx: MessageContext<C>): Promise<boolean> {
    try {
      const { status } = await ctx.getAuthor()
      if (status === "creator" || status === "administrator") return true

      const [isGroupAdmin, grant] = await Promise.all([
        api.tg.permissions.checkGroup.query({ userId: ctx.from.id, groupId: ctx.chatId }),
        api.tg.grants.checkUser.query({ userId: ctx.from.id }),
      ])
      return isGroupAdmin || grant.isGranted
    } catch (error) {
      reportDependencyError(error, "message exemption check")
      return true
    }
  }

  private async isJoinExempt(userId: number): Promise<boolean | null> {
    try {
      const [{ roles }, grant] = await Promise.all([
        api.tg.permissions.getRoles.query({ userId }),
        api.tg.grants.checkUser.query({ userId }),
      ])
      return Boolean(roles?.some((role) => NETWORK_PRIVILEGED_ROLES.has(role))) || grant.isGranted
    } catch (error) {
      reportDependencyError(error, "join exemption check")
      return null
    }
  }

  private recordMessageTelemetry(
    ctx: MessageContext<C>,
    decision: "allow" | "ban_all" | "quarantine",
    reasons: readonly string[],
    distinctAuthors: number,
    distinctChats: number
  ) {
    ctx.point
      .tag("campaign_spam_mode", campaignSpamConfig.mode)
      .tag("campaign_spam_decision", decision)
      .stringField("campaign_spam_reasons", reasons.join(",") || "none")
      .intField("campaign_spam_distinct_authors", distinctAuthors)
      .intField("campaign_spam_distinct_chats", distinctChats)
  }

  private async inspect(signals: CampaignMessageSignals, actorId: number, chatId: number) {
    try {
      return await this.reputation.inspectAndRecord(signals, actorId, chatId)
    } catch (error) {
      reportDependencyError(error, "reputation inspection")
      return this.reputation.configuredOnly(signals)
    }
  }

  private async handleMessage(ctx: MessageContext<C>) {
    if (
      ctx.chat.type === "private" ||
      ctx.from.id === ctx.me.id ||
      ctx.from.is_bot ||
      (await this.isMessageExempt(ctx))
    )
      return

    const signals = messageSignals(ctx.msg)
    const reputation = await this.inspect(signals, ctx.from.id, ctx.chatId)
    const classification = classifyCampaignMessage(signals, reputation)
    this.recordMessageTelemetry(
      ctx,
      classification.decision,
      classification.reasons,
      reputation.distinctAuthors,
      reputation.distinctChats
    )

    if (classification.decision !== "allow") {
      logger.info(
        {
          actorId: ctx.from.id,
          chatId: ctx.chatId,
          decision: classification.decision,
          reasons: classification.reasons,
          signatureHash: signals.signatureHash,
          entityTypes: signals.entityTypes,
          hasInlineKeyboard: signals.hasInlineKeyboard,
          viaBotId: signals.viaBotId,
          distinctAuthors: reputation.distinctAuthors,
          distinctChats: reputation.distinctChats,
        },
        "[CampaignSpam] Classified message"
      )
    }

    if (campaignSpamConfig.mode === "observe") return

    if (classification.decision === "allow") {
      await this.releasePendingMember(ctx)
      return
    }

    const reason = `Campaign spam: ${classification.reasons.join(", ")}`
    if (classification.decision === "quarantine" || campaignSpamConfig.mode === "quarantine") {
      const result = await Moderation.mute(
        ctx.from,
        ctx.chat,
        ctx.me,
        duration.zod.parse(campaignSpamConfig.quarantineDuration),
        [ctx.msg],
        reason
      )
      if (result.isErr()) {
        logger.error(
          { error: result.error, actorId: ctx.from.id, chatId: ctx.chatId },
          "[CampaignSpam] Quarantine failed"
        )
      }
      return
    }

    await this.enforceBanAll(ctx, signals, reason)
  }

  private async releasePendingMember(ctx: MessageContext<C>): Promise<void> {
    let pending = false
    try {
      pending = await this.reputation.isPending(ctx.chatId, ctx.from.id)
    } catch (error) {
      reportDependencyError(error, "pending member lookup")
      return
    }
    if (!pending) return

    try {
      await ctx.api.restrictChatMember(ctx.chatId, ctx.from.id, RestrictPermissions.unmute)
      await this.reputation.clearPending(ctx.chatId, ctx.from.id)
      logger.info({ actorId: ctx.from.id, chatId: ctx.chatId }, "[CampaignSpam] Released first-post restriction")
    } catch (error) {
      reportDependencyError(error, "first-post restriction release")
    }
  }

  private async claimBanAll(actorId: number): Promise<boolean> {
    try {
      return await this.reputation.claimBanAll(actorId)
    } catch (error) {
      reportDependencyError(error, "BanAll claim")
      if (this.localBanAllClaims.has(actorId)) return false
      this.localBanAllClaims.add(actorId)
      return true
    }
  }

  private async releaseBanAllClaim(actorId: number): Promise<void> {
    this.localBanAllClaims.delete(actorId)
    try {
      await this.reputation.releaseBanAllClaim(actorId)
    } catch (error) {
      reportDependencyError(error, "BanAll claim release")
    }
  }

  private async enforceBanAll(ctx: MessageContext<C>, signals: CampaignMessageSignals, reason: string) {
    try {
      await this.reputation.recordConfirmed(signals, actorFromUser(ctx.from))
    } catch (error) {
      reportDependencyError(error, "confirmed campaign recording")
    }

    const localBan = await Moderation.ban(ctx.from, ctx.chat, ctx.me, null, [ctx.msg], reason)
    if (localBan.isErr()) {
      logger.error(
        { error: localBan.error, actorId: ctx.from.id, chatId: ctx.chatId },
        "[CampaignSpam] Local ban failed"
      )
    }

    if (!(await this.claimBanAll(ctx.from.id))) return
    const result = await modules.get("tgLogger").banAll(ctx.from, ctx.me, "BAN", reason)
    if (result.started) return

    await this.releaseBanAllClaim(ctx.from.id)
    logger.error({ actorId: ctx.from.id }, "[CampaignSpam] BanAll could not start")
  }

  private async handleMemberUpdate(ctx: Filter<C, "chat_member">) {
    const { old_chat_member: oldMember, new_chat_member: newMember } = ctx.chatMember
    if (oldMember.status !== "left" || newMember.status !== "member") return
    try {
      await this.reputation.recordJoin(newMember.user.id)
    } catch (error) {
      reportDependencyError(error, "member join recording")
    }
  }

  private async handleJoinRequest(ctx: Filter<C, "chat_join_request">) {
    const user = ctx.chatJoinRequest.from
    let joinReputation: CampaignJoinReputation = {
      deniedUser: false,
      confirmedProfile: false,
      profileAuthors: 0,
    }
    try {
      joinReputation = await this.reputation.inspectJoin(actorFromUser(user))
    } catch (error) {
      reportDependencyError(error, "join request inspection")
    }

    const shouldDecline = joinReputation.deniedUser || joinReputation.confirmedProfile
    ctx.point
      .tag("campaign_spam_join_recommendation", shouldDecline ? "decline" : "restrict")
      .intField("campaign_spam_profile_authors", joinReputation.profileAuthors)

    logger.info(
      {
        actorId: user.id,
        chatId: ctx.chat.id,
        shouldDecline,
        deniedUser: joinReputation.deniedUser,
        confirmedProfile: joinReputation.confirmedProfile,
        profileAuthors: joinReputation.profileAuthors,
      },
      "[CampaignSpam] Inspected join request"
    )

    if (!campaignSpamConfig.joinGate || campaignSpamConfig.mode === "observe") return

    const exempt = await this.isJoinExempt(user.id)
    if (exempt === null || exempt) {
      await ctx.api.approveChatJoinRequest(ctx.chat.id, user.id)
      return
    }

    if (shouldDecline && campaignSpamConfig.mode === "enforce") {
      await ctx.api.declineChatJoinRequest(ctx.chat.id, user.id)
      return
    }

    await ctx.api.approveChatJoinRequest(ctx.chat.id, user.id)
    try {
      await this.reputation.recordJoin(user.id)
      await this.reputation.markPending(ctx.chat.id, user.id)
      await ctx.api.restrictChatMember(ctx.chat.id, user.id, FIRST_POST_PERMISSIONS, {
        until_date: Math.floor(Date.now() / 1000) + campaignSpamConfig.pendingMemberSeconds,
        use_independent_chat_permissions: true,
      })
    } catch (error) {
      await this.reputation.clearPending(ctx.chat.id, user.id).catch(() => {})
      reportDependencyError(error, "first-post restriction")
    }
  }
}
