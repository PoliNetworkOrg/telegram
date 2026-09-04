import type { Filter } from "grammy"
import type { ChatPermissions, Message } from "grammy/types"
import { api } from "@/backend"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { measureForkDuration, type TelemetryContextFlavor, TrackedMiddleware } from "@/modules/telemetry"
import { RestrictPermissions } from "@/utils/chat"
import { duration } from "@/utils/duration"
import { getText } from "@/utils/messages"
import { throttle } from "@/utils/throttle"
import type { Context } from "@/utils/types"
import { hasActiveBanAll } from "./audit-history"
import {
  CAMPAIGN_SPAM_MODEL_VERSION,
  type CampaignMessageSignals,
  type CampaignSpamDecision,
  type CampaignSpamReason,
  classifyCampaignJoin,
  classifyCampaignMessage,
  extractCampaignSignals,
} from "./classifier"
import { type CampaignJoinReputation, campaignActorFromUser } from "./reputation"
import { campaignSpamReviewKeyboard, campaignSpamReviewText } from "./review"
import type { CampaignSpamReview } from "./review-payload"
import { campaignSpamConfig } from "./runtime-config"
import { campaignSpamReputation } from "./service"

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

/** Rate-limits dependency failure logs while the guard fails open. */
const reportDependencyError = throttle((error: unknown, operation: string) => {
  logger.error({ error, operation }, "[CampaignSpam] Dependency error; failing open")
}, 60_000)

/** Extracts URL-bearing buttons and keyboard presence from a Telegram message. */
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

/** Converts a Telegram message into protected campaign classifier signals. */
function messageSignals(message: Message): CampaignMessageSignals {
  const text = getText(message).text ?? ""
  const entities =
    "entities" in message ? message.entities : "caption_entities" in message ? message.caption_entities : []
  const inlineKeyboard = inlineKeyboardSignals(message)
  return extractCampaignSignals(
    {
      text,
      entityTypes: entities?.map((entity) => entity.type),
      mentionedUserIds: entities?.flatMap((entity) => (entity.type === "text_mention" ? [entity.user.id] : [])),
      buttonUrls: inlineKeyboard.buttonUrls,
      hasInlineKeyboard: inlineKeyboard.hasInlineKeyboard,
      viaBotId: message.via_bot?.id,
      viaBotUsername: message.via_bot?.username,
    },
    campaignSpamConfig.fingerprintSecret
  )
}

/** Orchestrates campaign classification, admission controls, review, and enforcement. */
export class CampaignSpamGuard<C extends TelemetryContextFlavor<Context>> extends TrackedMiddleware<C> {
  private readonly reputation = campaignSpamReputation
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

  /** Exempts trusted senders and fails open when trust cannot be verified. */
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

  /** Returns null when join exemption checks fail so the caller can approve safely. */
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

  /** Checks whether audit history currently places the exact account under BanAll. */
  private async wasBanAllTarget(userId: number): Promise<boolean> {
    try {
      return hasActiveBanAll(await api.tg.auditLog.getById.query({ targetId: userId }))
    } catch (error) {
      reportDependencyError(error, "BanAll audit lookup")
      return false
    }
  }

  /** Attaches explainable classifier inputs and outcomes to update telemetry. */
  private recordMessageTelemetry(
    ctx: MessageContext<C>,
    decision: CampaignSpamDecision,
    reasons: readonly CampaignSpamReason[],
    distinctAuthors: number,
    distinctChats: number,
    isFirstPost: boolean
  ) {
    ctx.point
      .tag("campaign_spam_mode", campaignSpamConfig.mode)
      .tag("campaign_spam_model", CAMPAIGN_SPAM_MODEL_VERSION)
      .tag("campaign_spam_decision", decision)
      .tag("campaign_spam_phase", isFirstPost ? "first_post" : "message")
      .stringField("campaign_spam_reasons", reasons.join(",") || "none")
      .intField("campaign_spam_distinct_authors", distinctAuthors)
      .intField("campaign_spam_distinct_chats", distinctChats)
  }

  /** Reads reputation with a static-only fallback when Redis is unavailable. */
  private async inspectAndRecordReputation(signals: CampaignMessageSignals, actorId: number, chatId: number) {
    try {
      return await this.reputation.inspectAndRecord(signals, actorId, chatId)
    } catch (error) {
      reportDependencyError(error, "reputation inspection")
      return this.reputation.configuredOnly(signals, actorId)
    }
  }

  /** Checks first-post state without making Redis failure block a message. */
  private async isPendingMember(chatId: number, actorId: number): Promise<boolean> {
    try {
      return await this.reputation.isPending(chatId, actorId)
    } catch (error) {
      reportDependencyError(error, "pending member lookup")
      return false
    }
  }

  /** Sends a review item to the action-required topic without blocking enforcement. */
  private async queueReview(review: CampaignSpamReview, sourceMessage?: Message): Promise<void> {
    try {
      const keyboard = await campaignSpamReviewKeyboard(review)
      const queued = await modules
        .get("tgLogger")
        .actionRequired(campaignSpamReviewText(review), keyboard, sourceMessage)
      if (!queued) logger.error({ actorId: review.target.id }, "[CampaignSpam] Review could not be queued")
    } catch (error) {
      reportDependencyError(error, "campaign review queue")
    }
  }

  /** Classifies a message and applies the configured rollout behavior. */
  private async handleMessage(ctx: MessageContext<C>) {
    if (
      ctx.chat.type === "private" ||
      ctx.from.id === ctx.me.id ||
      ctx.from.is_bot ||
      (await this.isMessageExempt(ctx))
    )
      return

    const signals = messageSignals(ctx.msg)
    const [reputation, isPending] = await Promise.all([
      this.inspectAndRecordReputation(signals, ctx.from.id, ctx.chatId),
      this.isPendingMember(ctx.chatId, ctx.from.id),
    ])
    const isFirstPost = isPending && ctx.update.message !== undefined
    const classification = classifyCampaignMessage(signals, reputation)
    this.recordMessageTelemetry(
      ctx,
      classification.decision,
      classification.reasons,
      reputation.distinctAuthors,
      reputation.distinctChats,
      isFirstPost
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
          viaBotIdHash: signals.viaBotIdHash,
          distinctAuthors: reputation.distinctAuthors,
          distinctChats: reputation.distinctChats,
        },
        "[CampaignSpam] Classified message"
      )
    }

    if (campaignSpamConfig.mode === "observe") return

    if (classification.decision === "allow") {
      if (isFirstPost) await this.releasePendingMember(ctx)
      return
    }

    const reason = `Campaign spam: ${classification.reasons.join(", ")}`
    if (classification.decision === "quarantine" || campaignSpamConfig.mode === "quarantine") {
      await this.queueReview(
        {
          source: "message",
          target: ctx.from,
          chat: ctx.chat,
          reasons: classification.reasons,
          signals: { signatureHash: signals.signatureHash },
        },
        ctx.msg
      )
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

  /** Restores normal permissions after an allowed first post. */
  private async releasePendingMember(ctx: MessageContext<C>): Promise<void> {
    try {
      await ctx.api.restrictChatMember(ctx.chatId, ctx.from.id, RestrictPermissions.unmute)
      await this.reputation.clearPending(ctx.chatId, ctx.from.id)
      logger.info({ actorId: ctx.from.id, chatId: ctx.chatId }, "[CampaignSpam] Released first-post restriction")
    } catch (error) {
      reportDependencyError(error, "first-post restriction release")
    }
  }

  /** Deduplicates network-wide ban jobs, with a process-local Redis fallback. */
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

  /** Releases both distributed and local claims after a failed BanAll start. */
  private async releaseBanAllClaim(actorId: number): Promise<void> {
    this.localBanAllClaims.delete(actorId)
    try {
      await this.reputation.releaseBanAllClaim(actorId)
    } catch (error) {
      reportDependencyError(error, "BanAll claim release")
    }
  }

  /** Records confirmed evidence, bans locally, and starts one BanAll job. */
  private async enforceBanAll(ctx: MessageContext<C>, signals: CampaignMessageSignals, reason: string) {
    try {
      await this.reputation.recordConfirmed(signals, campaignActorFromUser(ctx.from))
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

  /** Records direct joins so freshness works outside the join-request flow. */
  private async handleMemberUpdate(ctx: Filter<C, "chat_member">) {
    const { old_chat_member: oldMember, new_chat_member: newMember } = ctx.chatMember
    if (oldMember.status !== "left" || newMember.status !== "member") return
    try {
      await this.reputation.recordJoin(newMember.user.id)
    } catch (error) {
      reportDependencyError(error, "member join recording")
    }
  }

  /** Applies exact-ID and profile reputation to a join request. */
  private async handleJoinRequest(ctx: Filter<C, "chat_join_request">) {
    const user = ctx.chatJoinRequest.from
    let joinReputation: CampaignJoinReputation = {
      deniedUser: false,
      confirmedProfile: false,
      profileAuthors: 0,
    }
    const [historicalBanAll, storedJoinReputation] = await Promise.all([
      this.wasBanAllTarget(user.id),
      this.reputation.inspectJoin(campaignActorFromUser(user)).catch((error) => {
        reportDependencyError(error, "join request inspection")
        return null
      }),
    ])
    if (storedJoinReputation) joinReputation = storedJoinReputation
    if (historicalBanAll) {
      joinReputation.deniedUser = true
      await this.reputation.recordDeniedUser(user.id).catch((error) => {
        reportDependencyError(error, "historical BanAll recording")
      })
    }

    const joinClassification = classifyCampaignJoin(joinReputation)
    const shouldDecline = joinClassification.decision === "decline"
    ctx.point
      .tag("campaign_spam_model", CAMPAIGN_SPAM_MODEL_VERSION)
      .tag("campaign_spam_join_recommendation", shouldDecline ? "decline" : "restrict")
      .intField("campaign_spam_profile_authors", joinReputation.profileAuthors)

    logger.info(
      {
        actorId: user.id,
        chatId: ctx.chat.id,
        shouldDecline,
        deniedUser: joinReputation.deniedUser,
        confirmedProfile: joinReputation.confirmedProfile,
        historicalBanAll,
        profileAuthors: joinReputation.profileAuthors,
      },
      "[CampaignSpam] Inspected join request"
    )

    if (!campaignSpamConfig.joinGate) {
      ctx.point.tag("campaign_spam_join_outcome", "gate_disabled")
      return
    }
    if (campaignSpamConfig.mode === "observe") {
      ctx.point.tag("campaign_spam_join_outcome", "observed")
      return
    }

    const exempt = await this.isJoinExempt(user.id)
    if (exempt === null || exempt) {
      await ctx.api.approveChatJoinRequest(ctx.chat.id, user.id)
      ctx.point.tag("campaign_spam_join_outcome", exempt ? "approved_exempt" : "approved_dependency_fallback")
      return
    }

    if (shouldDecline && campaignSpamConfig.mode === "enforce") {
      await ctx.api.declineChatJoinRequest(ctx.chat.id, user.id)
      ctx.point.tag("campaign_spam_join_outcome", "declined")
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
      ctx.point.tag("campaign_spam_join_outcome", "approved_restricted")
      if (joinClassification.reviewReason) {
        await this.queueReview({
          source: "join_request",
          target: user,
          chat: ctx.chat,
          reasons: [joinClassification.reviewReason],
        })
      }
    } catch (error) {
      await this.reputation.clearPending(ctx.chat.id, user.id).catch(() => {})
      ctx.point.tag("campaign_spam_join_outcome", "approved_unrestricted")
      reportDependencyError(error, "first-post restriction")
    }
  }
}
