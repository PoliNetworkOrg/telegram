import type { Filter } from "grammy"
import type { ChatPermissions, Message } from "grammy/types"
import { api } from "@/backend"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { measureForkDuration, type TelemetryContextFlavor, TrackedMiddleware } from "@/modules/telemetry"
import { RestrictPermissions } from "@/utils/chat"
import { duration } from "@/utils/duration"
import { throttle } from "@/utils/throttle"
import type { Context } from "@/utils/types"
import { inspectMessageTrust } from "../message-trust"
import { hasActiveBanAll } from "./audit-history"
import {
  CAMPAIGN_SPAM_MODEL_VERSION,
  type CampaignMessageSignals,
  type CampaignReputationSnapshot,
  type CampaignSpamDecision,
  type CampaignSpamReason,
  classifyCampaignJoin,
  classifyCampaignMessage,
  extractCampaignSignals,
  isCampaignCandidate,
} from "./classifier"
import { campaignMessageInput } from "./message-input"
import {
  CAMPAIGN_REVIEW_RETENTION_SECONDS,
  CampaignActorOperationBusyError,
  type CampaignJoinReputation,
  type CampaignPendingState,
  campaignActorFromUser,
  shouldAutoReleasePendingMember,
} from "./reputation"
import { campaignSpamReviewKeyboard, campaignSpamReviewText } from "./review"
import { type CampaignSpamReview, createCampaignSpamReview } from "./review-payload"
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
const REVIEW_PERMISSIONS = {
  ...FIRST_POST_PERMISSIONS,
  can_send_messages: false,
} satisfies ChatPermissions

/** Keeps review-held accounts read-only while ordinary admissions may send one text post. */
function pendingPermissions(state: CampaignPendingState): ChatPermissions {
  return state === "review" ? REVIEW_PERMISSIONS : FIRST_POST_PERMISSIONS
}

/** Aligns each Telegram hold with the lifetime of its recoverable Redis state. */
function pendingRestrictionOptions(state: CampaignPendingState): {
  until_date?: number
  use_independent_chat_permissions: true
} {
  const retentionSeconds =
    state === "review" ? CAMPAIGN_REVIEW_RETENTION_SECONDS : campaignSpamConfig.pendingMemberSeconds
  return {
    until_date: Math.floor(Date.now() / 1000) + retentionSeconds,
    use_independent_chat_permissions: true,
  }
}

type MessageContext<C extends Context> = Filter<
  C,
  "message:text" | "message:caption" | "message:contact" | "edited_message:text" | "edited_message:caption"
>

/** Rate-limits dependency failure logs while the guard fails open. */
const reportDependencyError = throttle((error: unknown, operation: string) => {
  logger.error({ error, operation }, "[CampaignSpam] Dependency error; failing open")
}, 60_000)

/** Converts a Telegram message into protected campaign classifier signals. */
function messageSignals(message: Message): CampaignMessageSignals {
  return extractCampaignSignals(campaignMessageInput(message), campaignSpamConfig.fingerprintSecret)
}

/** Orchestrates campaign classification, admission controls, review, and enforcement. */
export class CampaignSpamGuard<C extends TelemetryContextFlavor<Context>> extends TrackedMiddleware<C> {
  private readonly reputation = campaignSpamReputation

  constructor() {
    super("campaign_spam")
    if (campaignSpamConfig.mode === "off") return

    this.composer
      .on(["message:text", "message:caption", "message:contact", "edited_message:text", "edited_message:caption"])
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
    const trust = await inspectMessageTrust(ctx)
    if (trust.status === "unavailable") {
      reportDependencyError(trust.error, "message exemption check")
      return true
    }
    return trust.status === "trusted"
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
    signals: CampaignMessageSignals,
    decision: CampaignSpamDecision,
    reasons: readonly CampaignSpamReason[],
    reputation: CampaignReputationSnapshot,
    isFirstPost: boolean
  ) {
    ctx.point
      .tag("campaign_spam_mode", campaignSpamConfig.mode)
      .tag("campaign_spam_model", CAMPAIGN_SPAM_MODEL_VERSION)
      .tag("campaign_spam_decision", decision)
      .tag("campaign_spam_phase", isFirstPost ? "first_post" : "message")
      .tag("campaign_spam_source", signals.source)
      .stringField("campaign_spam_reasons", reasons.join(",") || "none")
      .booleanField("campaign_spam_candidate", isCampaignCandidate(signals))
      .intField("campaign_spam_distinct_authors", reputation.distinctAuthors)
      .intField("campaign_spam_distinct_chats", reputation.distinctChats)
      .intField("campaign_spam_slow_distinct_authors", reputation.slowDistinctAuthors)
      .intField("campaign_spam_slow_distinct_chats", reputation.slowDistinctChats)
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

  /** Reads admission state without making a Redis failure block a message. */
  private async pendingMemberState(chatId: number, actorId: number): Promise<CampaignPendingState | null> {
    try {
      return await this.reputation.pendingState(chatId, actorId)
    } catch (error) {
      reportDependencyError(error, "pending member lookup")
      return null
    }
  }

  /** Sends a review item to the action-required topic without blocking enforcement. */
  private async queueReview(review: CampaignSpamReview, sourceMessage?: Message): Promise<boolean> {
    try {
      const keyboard = await campaignSpamReviewKeyboard(review)
      const queued = await modules
        .get("tgLogger")
        .actionRequired(campaignSpamReviewText(review), keyboard, sourceMessage)
      if (!queued) logger.error({ actorId: review.target.id }, "[CampaignSpam] Review could not be queued")
      return queued
    } catch (error) {
      reportDependencyError(error, "campaign review queue")
      return false
    }
  }

  /** Falls back to the short first-post hold when no moderator review was delivered. */
  private async downgradeUndeliveredReview(
    ctx: C,
    chatId: number,
    actorId: number,
    outcomeTag: string,
    assertOwned: () => Promise<void>
  ): Promise<void> {
    try {
      await assertOwned()
      await ctx.api.restrictChatMember(chatId, actorId, FIRST_POST_PERMISSIONS, pendingRestrictionOptions("first_post"))
      await assertOwned()
      await this.reputation.markPending(chatId, actorId, "first_post")
      ctx.point.tag(outcomeTag, "restricted_first_post_review_delivery_fallback")
    } catch (error) {
      await this.restorePendingAdmission(ctx, chatId, actorId, assertOwned)
      ctx.point.tag(outcomeTag, "unrestricted_review_delivery_fallback")
      reportDependencyError(error, "undelivered review downgrade")
    }
  }

  /** Restores a failed hold only while its actor workflow still owns the lease. */
  private async restorePendingAdmission(
    ctx: C,
    chatId: number,
    actorId: number,
    assertOwned: () => Promise<void>
  ): Promise<boolean> {
    try {
      await assertOwned()
      await ctx.api.restrictChatMember(chatId, actorId, RestrictPermissions.unmute)
      await assertOwned()
    } catch (error) {
      reportDependencyError(error, "admission permission restoration")
      return false
    }
    try {
      await this.reputation.clearPending(chatId, actorId)
      return true
    } catch (error) {
      reportDependencyError(error, "admission state cleanup")
      return false
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
    const [reputation, pendingState] = await Promise.all([
      this.inspectAndRecordReputation(signals, ctx.from.id, ctx.chatId),
      this.pendingMemberState(ctx.chatId, ctx.from.id),
    ])
    const isNewMessage = ctx.update.message !== undefined
    const isFirstPost = pendingState !== null && isNewMessage
    const classification = classifyCampaignMessage(signals, reputation, { firstPost: isFirstPost })
    this.recordMessageTelemetry(ctx, signals, classification.decision, classification.reasons, reputation, isFirstPost)

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
          slowDistinctAuthors: reputation.slowDistinctAuthors,
          slowDistinctChats: reputation.slowDistinctChats,
        },
        "[CampaignSpam] Classified message"
      )
    }

    if (campaignSpamConfig.mode === "observe") return

    if (classification.decision === "allow") {
      if (shouldAutoReleasePendingMember(pendingState, isNewMessage)) await this.releasePendingMember(ctx)
      return
    }

    const reason = `Campaign spam: ${classification.reasons.join(", ")}`
    if (classification.decision === "quarantine" || campaignSpamConfig.mode === "quarantine") {
      const review = createCampaignSpamReview({
        source: "message",
        target: ctx.from,
        chat: ctx.chat,
        reasons: classification.reasons,
        signals: { signatureHash: signals.signatureHash },
      })
      try {
        await this.reputation.runActorOperation(campaignActorFromUser(ctx.from), async (mutations) => {
          await mutations.assertOwned()
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
            return
          }

          await mutations.markCurrentReview(ctx.chatId, review.reviewId)
          if (!(await this.queueReview(review, ctx.msg))) {
            await mutations.clearCurrentReview(ctx.chatId, review.reviewId)
          }
        })
      } catch (error) {
        reportDependencyError(error, "campaign quarantine")
      }
      return
    }

    await this.enforceBanAll(ctx, signals, reason)
  }

  /** Restores normal permissions after an allowed first post. */
  private async releasePendingMember(ctx: MessageContext<C>): Promise<void> {
    try {
      await this.reputation.runActorOperation(campaignActorFromUser(ctx.from), async (mutations) => {
        await mutations.assertOwned()
        const currentState = await this.pendingMemberState(ctx.chatId, ctx.from.id)
        if (!shouldAutoReleasePendingMember(currentState, true)) return
        await ctx.api.restrictChatMember(ctx.chatId, ctx.from.id, RestrictPermissions.unmute)
        await mutations.assertOwned()
        await this.reputation.clearPending(ctx.chatId, ctx.from.id)
        logger.info({ actorId: ctx.from.id, chatId: ctx.chatId }, "[CampaignSpam] Released first-post restriction")
      })
    } catch (error) {
      reportDependencyError(error, "first-post restriction release")
    }
  }

  /** Serializes the local ban, confirmed evidence, and one network BanAll job. */
  private async enforceBanAll(ctx: MessageContext<C>, signals: CampaignMessageSignals, reason: string) {
    const actor = campaignActorFromUser(ctx.from)
    try {
      await this.reputation.runActorOperation(actor, async (mutations) => {
        await mutations.assertOwned()
        const localBan = await Moderation.ban(ctx.from, ctx.chat, ctx.me, null, [ctx.msg], reason)
        if (localBan.isErr()) {
          logger.error(
            { error: localBan.error, actorId: ctx.from.id, chatId: ctx.chatId },
            "[CampaignSpam] Local ban failed"
          )
          return
        }
        await mutations.recordConfirmed(signals)
        await this.reputation.clearPending(ctx.chatId, ctx.from.id).catch((error) => {
          reportDependencyError(error, "confirmed member pending-state cleanup")
        })

        const claim = await this.reputation.claimBanAllOperation(ctx.from.id)
        if (claim.status !== "claimed") return

        try {
          await Promise.all([mutations.assertOwned(), this.reputation.assertBanAllOperation(ctx.from.id, claim.token)])
          const result = await modules.get("tgLogger").banAll(ctx.from, ctx.me, "BAN", reason, claim.idempotencyKey)
          await Promise.all([mutations.assertOwned(), this.reputation.assertBanAllOperation(ctx.from.id, claim.token)])
          if (result.started) {
            const completed = await this.reputation.completeBanAllOperation(ctx.from.id, claim.token)
            if (!completed) logger.warn({ actorId: ctx.from.id }, "[CampaignSpam] BanAll lease expired")
            return
          }

          await this.reputation.releaseBanAllOperation(ctx.from.id, claim.token)
          logger.error({ actorId: ctx.from.id }, "[CampaignSpam] BanAll could not start")
        } catch (error) {
          await this.reputation.releaseBanAllOperation(ctx.from.id, claim.token).catch(() => {})
          reportDependencyError(error, "BanAll start")
        }
      })
    } catch (error) {
      reportDependencyError(error, "confirmed campaign enforcement")
    }
  }

  /** Records and restricts direct joins so the first-post guard cannot be bypassed by waiting. */
  private async handleMemberUpdate(ctx: Filter<C, "chat_member">) {
    const { old_chat_member: oldMember, new_chat_member: newMember } = ctx.chatMember
    if (ctx.chat.type === "private" || oldMember.status !== "left" || newMember.status !== "member") return
    try {
      await this.reputation.recordJoin(newMember.user.id)
    } catch (error) {
      reportDependencyError(error, "member join recording")
    }

    if (!campaignSpamConfig.joinGate || campaignSpamConfig.mode === "observe" || newMember.user.is_bot) return

    if (ctx.chatMember.via_join_request) {
      try {
        const replayed = await this.reputation.runActorOperation(
          campaignActorFromUser(newMember.user),
          async (mutations) => {
            const existingState = await this.pendingMemberState(ctx.chat.id, newMember.user.id)
            if (existingState === null) return false
            await mutations.assertOwned()
            await ctx.api.restrictChatMember(
              ctx.chat.id,
              newMember.user.id,
              pendingPermissions(existingState),
              pendingRestrictionOptions(existingState)
            )
            await mutations.assertOwned()
            return true
          }
        )
        if (replayed) {
          ctx.point.tag("campaign_spam_member_join_outcome", "restricted_join_request_replay")
          return
        }
      } catch (error) {
        ctx.point.tag("campaign_spam_member_join_outcome", "restriction_replay_failed")
        reportDependencyError(error, "join-request restriction replay")
        return
      }
    }

    const exempt = await this.isJoinExempt(newMember.user.id)
    if (exempt === null || exempt) return

    const joinReputation = await this.reputation.inspectJoin(campaignActorFromUser(newMember.user)).catch((error) => {
      reportDependencyError(error, "direct-join profile inspection")
      return null
    })
    const reviewReason = joinReputation ? classifyCampaignJoin(joinReputation).reviewReason : undefined
    const review = reviewReason
      ? createCampaignSpamReview({
          source: "member_join",
          target: newMember.user,
          chat: ctx.chat,
          reasons: [reviewReason],
        })
      : undefined
    const pendingState: CampaignPendingState = review ? "review" : "first_post"

    try {
      await this.reputation.runActorOperation(campaignActorFromUser(newMember.user), async (mutations) => {
        try {
          await mutations.assertOwned()
          await this.reputation.markPending(ctx.chat.id, newMember.user.id, pendingState)
          await mutations.assertOwned()
          await ctx.api.restrictChatMember(
            ctx.chat.id,
            newMember.user.id,
            pendingPermissions(pendingState),
            pendingRestrictionOptions(pendingState)
          )
          await mutations.assertOwned()
          ctx.point.tag("campaign_spam_member_join_outcome", "restricted")

          if (review) {
            await mutations.markCurrentReview(ctx.chat.id, review.reviewId)
            if (!(await this.queueReview(review))) {
              await mutations.clearCurrentReview(ctx.chat.id, review.reviewId)
              await this.downgradeUndeliveredReview(
                ctx,
                ctx.chat.id,
                newMember.user.id,
                "campaign_spam_member_join_outcome",
                mutations.assertOwned
              )
            }
          }
        } catch (error) {
          const restored = await this.restorePendingAdmission(
            ctx,
            ctx.chat.id,
            newMember.user.id,
            mutations.assertOwned
          )
          if (restored && review) await mutations.clearCurrentReview(ctx.chat.id, review.reviewId)
          throw error
        }
      })
    } catch (error) {
      if (error instanceof CampaignActorOperationBusyError) {
        ctx.point.tag("campaign_spam_member_join_outcome", "concurrent_operation")
        return
      }
      ctx.point.tag("campaign_spam_member_join_outcome", "dependency_fallback")
      reportDependencyError(error, "direct-join first-post restriction")
      return
    }
  }

  /** Applies exact-ID and profile reputation to a join request. */
  private async handleJoinRequest(ctx: Filter<C, "chat_join_request">) {
    const user = ctx.chatJoinRequest.from
    let joinReputation: CampaignJoinReputation = {
      deniedUser: false,
      confirmedProfile: false,
      profileAuthors: 0,
      riskyProfile: false,
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
      try {
        await this.reputation.recordDeniedUser(user.id)
      } catch (error) {
        reportDependencyError(error, "historical BanAll recording")
      }
    }

    const joinClassification = classifyCampaignJoin(joinReputation)
    const shouldDecline = joinClassification.decision === "decline"
    ctx.point
      .tag("campaign_spam_model", CAMPAIGN_SPAM_MODEL_VERSION)
      .tag("campaign_spam_join_recommendation", shouldDecline ? "decline" : "restrict")
      .booleanField("campaign_spam_risky_profile", joinReputation.riskyProfile)
      .intField("campaign_spam_profile_authors", joinReputation.profileAuthors)

    logger.info(
      {
        actorId: user.id,
        chatId: ctx.chat.id,
        shouldDecline,
        deniedUser: joinReputation.deniedUser,
        confirmedProfile: joinReputation.confirmedProfile,
        riskyProfile: joinReputation.riskyProfile,
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

    const review = joinClassification.reviewReason
      ? createCampaignSpamReview({
          source: "join_request",
          target: user,
          chat: ctx.chat,
          reasons: [joinClassification.reviewReason],
        })
      : undefined
    const pendingState: CampaignPendingState = review ? "review" : "first_post"
    let approved = false

    try {
      await this.reputation.runActorOperation(campaignActorFromUser(user), async (mutations) => {
        try {
          await mutations.assertOwned()
          await this.reputation.recordJoin(user.id)
          await this.reputation.markPending(ctx.chat.id, user.id, pendingState)
          await mutations.assertOwned()
          await ctx.api.approveChatJoinRequest(ctx.chat.id, user.id)
          approved = true
          await mutations.assertOwned()
          await ctx.api.restrictChatMember(
            ctx.chat.id,
            user.id,
            pendingPermissions(pendingState),
            pendingRestrictionOptions(pendingState)
          )
          await mutations.assertOwned()
          ctx.point.tag("campaign_spam_join_outcome", "approved_restricted")

          if (review) {
            await mutations.markCurrentReview(ctx.chat.id, review.reviewId)
            if (!(await this.queueReview(review))) {
              await mutations.clearCurrentReview(ctx.chat.id, review.reviewId)
              await this.downgradeUndeliveredReview(
                ctx,
                ctx.chat.id,
                user.id,
                "campaign_spam_join_outcome",
                mutations.assertOwned
              )
            }
          }
        } catch (error) {
          if (approved) {
            const restored = await this.restorePendingAdmission(ctx, ctx.chat.id, user.id, mutations.assertOwned)
            if (restored && review) await mutations.clearCurrentReview(ctx.chat.id, review.reviewId)
          } else {
            await mutations.assertOwned()
            await this.reputation.clearPending(ctx.chat.id, user.id)
            if (review) await mutations.clearCurrentReview(ctx.chat.id, review.reviewId)
          }
          throw error
        }
      })
    } catch (error) {
      if (error instanceof CampaignActorOperationBusyError) {
        ctx.point.tag("campaign_spam_join_outcome", "concurrent_operation")
        return
      }
      if (!approved) {
        try {
          await ctx.api.approveChatJoinRequest(ctx.chat.id, user.id)
          approved = true
        } catch (approvalError) {
          reportDependencyError(approvalError, "join-request fallback approval")
        }
      }
      ctx.point.tag("campaign_spam_join_outcome", "approved_dependency_fallback")
      reportDependencyError(error, "join admission state")
      return
    }
  }
}
