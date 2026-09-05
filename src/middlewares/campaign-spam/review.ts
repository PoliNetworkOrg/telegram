import { api } from "@/backend"
import { MenuGenerator } from "@/lib/menu"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { fmt, fmtChat, fmtUser } from "@/utils/format"
import type { Context } from "@/utils/types"
import { hasCampaignReviewRole } from "./authorization"
import { CAMPAIGN_REVIEW_RETENTION_SECONDS, campaignActorFromUser } from "./reputation"
import {
  type CampaignSpamReview,
  type CampaignSpamReviewDraft,
  openCampaignSpamReview,
  sealCampaignSpamReview,
} from "./review-payload"
import { campaignSpamConfig } from "./runtime-config"
import { campaignSpamReputation } from "./service"

export type { CampaignSpamReview, CampaignSpamReviewDraft } from "./review-payload"

type ReviewAccess = { review: CampaignSpamReview } | { feedback: string }

/** Authorizes a reviewer before validating and opening sensitive callback state. */
async function authorizeAndOpenReview(userId: number, payload: string): Promise<ReviewAccess> {
  try {
    const { roles } = await api.tg.permissions.getRoles.query({ userId })
    if (!hasCampaignReviewRole(roles)) return { feedback: "You are not authorized for this action" }
  } catch (error) {
    logger.error({ error, userId }, "[CampaignSpam] Failed to authorize campaign reviewer")
    return { feedback: "Reviewer authorization is temporarily unavailable" }
  }

  try {
    return { review: openCampaignSpamReview(payload, campaignSpamConfig.fingerprintSecret) }
  } catch (error) {
    logger.error({ error, userId }, "[CampaignSpam] Failed to open campaign review")
    return { feedback: "This review is invalid or no longer available" }
  }
}

/** Formats the action-required summary shown to network moderators. */
export function campaignSpamReviewText(review: CampaignSpamReviewDraft): string {
  const sourceLabel =
    review.source === "message"
      ? "message quarantine"
      : review.source === "member_join"
        ? "restricted direct join"
        : "restricted join request"
  return fmt(
    ({ b, code, n }) => [
      b`Campaign spam review`,
      n`${b`Source:`} ${sourceLabel}`,
      n`${b`Target:`} ${fmtUser(review.target)}`,
      n`${b`Group:`} ${fmtChat(review.chat)}`,
      n`${b`Reasons:`} ${code`${review.reasons.join(", ")}`}`,
    ],
    { sep: "\n" }
  )
}

const campaignSpamReviewMenu = MenuGenerator.getInstance<Context>().create<string>(
  "campaign-spam-review",
  [
    [
      {
        text: "Confirm BanAll",
        cb: async ({ data: payload, ctx }) => {
          const access = await authorizeAndOpenReview(ctx.from.id, payload)
          if (!("review" in access)) return access
          const data = access.review

          let reviewToken: string
          try {
            const claim = await campaignSpamReputation.claimReviewOperation(data.reviewId)
            if (claim.status === "completed") {
              return { deleteData: true, feedback: "This review was already decided" }
            }
            if (claim.status === "busy") return { feedback: "This review is being processed" }
            reviewToken = claim.token
          } catch (error) {
            logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Failed to claim review decision")
            return { feedback: "Review state is temporarily unavailable" }
          }

          let outcome: { completed: boolean; feedback: string }
          const actor = campaignActorFromUser(data.target)
          try {
            await campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken)
            outcome = await campaignSpamReputation.runActorOperation(actor, async (mutations) => {
              await Promise.all([
                mutations.assertOwned(),
                campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken),
              ])
              if (!(await mutations.isCurrentReview(data.chat.id, data.reviewId))) {
                return { completed: true, feedback: "A newer review superseded this item" }
              }
              const localBan = await Moderation.ban(
                data.target,
                data.chat,
                ctx.from,
                null,
                undefined,
                "Campaign spam confirmed by moderator"
              )
              if (localBan.isErr()) return { completed: false, feedback: localBan.error.strError }

              await Promise.all([
                mutations.assertOwned(),
                campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken),
              ])

              if (data.signals) {
                await mutations.recordConfirmed(data.signals)
              } else {
                await mutations.recordDeniedActor()
              }
              await campaignSpamReputation.clearPending(data.chat.id, data.target.id).catch((error) => {
                logger.error(
                  { error, actorId: data.target.id },
                  "[CampaignSpam] Failed to clear confirmed member state"
                )
              })

              const claim = await campaignSpamReputation.claimBanAllOperation(data.target.id)
              if (claim.status === "busy") {
                return { completed: false, feedback: "BanAll is being processed; retry shortly" }
              }
              if (claim.status === "completed") {
                await mutations.clearCurrentReview(data.chat.id, data.reviewId)
                return { completed: true, feedback: "BanAll was already completed" }
              }

              try {
                await Promise.all([
                  mutations.assertOwned(),
                  campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken),
                  campaignSpamReputation.assertBanAllOperation(data.target.id, claim.token),
                ])
                const result = await modules
                  .get("tgLogger")
                  .banAll(data.target, ctx.from, "BAN", "Campaign spam confirmed by moderator", claim.idempotencyKey)
                await Promise.all([
                  mutations.assertOwned(),
                  campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken),
                  campaignSpamReputation.assertBanAllOperation(data.target.id, claim.token),
                ])
                if (!result.started) {
                  await campaignSpamReputation.releaseBanAllOperation(data.target.id, claim.token)
                  return { completed: false, feedback: result.message }
                }

                const recorded = await campaignSpamReputation.completeBanAllOperation(data.target.id, claim.token)
                if (!recorded) logger.warn({ actorId: data.target.id }, "[CampaignSpam] BanAll lease expired")
                await mutations.clearCurrentReview(data.chat.id, data.reviewId)
                return { completed: true, feedback: "BanAll started" }
              } catch (error) {
                await campaignSpamReputation.releaseBanAllOperation(data.target.id, claim.token).catch(() => {})
                throw error
              }
            })
          } catch (error) {
            logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Moderator confirmation failed")
            await campaignSpamReputation.releaseReviewOperation(data.reviewId, reviewToken).catch(() => {})
            return { feedback: "BanAll is temporarily unavailable" }
          }

          if (!outcome.completed) {
            await campaignSpamReputation.releaseReviewOperation(data.reviewId, reviewToken).catch(() => {})
            return { feedback: outcome.feedback }
          }

          try {
            await campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken)
          } catch (error) {
            logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Lost review ownership after BanAll")
            await campaignSpamReputation.releaseReviewOperation(data.reviewId, reviewToken).catch(() => {})
            return { feedback: "BanAll started; retry to finalize this review" }
          }
          const reviewRecorded = await campaignSpamReputation
            .completeReviewOperation(data.reviewId, reviewToken)
            .catch((error) => {
              logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Failed to complete review state")
              return false
            })
          if (!reviewRecorded) {
            logger.warn({ actorId: data.target.id }, "[CampaignSpam] Review lease expired")
            return { feedback: "BanAll started; retry to finalize this review" }
          }
          ctx.point.tag("campaign_spam_moderator_feedback", "confirm")
          logger.info(
            { actorId: data.target.id, chatId: data.chat.id, moderatorId: ctx.from.id, reviewId: data.reviewId },
            "[CampaignSpam] Moderator confirm review completed"
          )
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
          return { deleteData: true, feedback: outcome.feedback }
        },
      },
      {
        text: "Release",
        cb: async ({ data: payload, ctx }) => {
          const access = await authorizeAndOpenReview(ctx.from.id, payload)
          if (!("review" in access)) return access
          const data = access.review

          let reviewToken: string
          try {
            const claim = await campaignSpamReputation.claimReviewOperation(data.reviewId)
            if (claim.status === "completed") {
              return { deleteData: true, feedback: "This review was already decided" }
            }
            if (claim.status === "busy") return { feedback: "This review is being processed" }
            reviewToken = claim.token
          } catch (error) {
            logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Failed to claim review release")
            return { feedback: "Review state is temporarily unavailable" }
          }

          let unmuteError = "Unable to restore permissions"
          let releaseResult: Awaited<ReturnType<typeof campaignSpamReputation.releaseConfirmedIfCurrent>>
          try {
            await campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken)
            releaseResult = await campaignSpamReputation.releaseConfirmedIfCurrent(
              campaignActorFromUser(data.target),
              data.createdAt,
              { chatId: data.chat.id, reviewId: data.reviewId },
              async () => {
                await campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken)
                const unmute = await Moderation.unmute(data.target, data.chat, ctx.from)
                if (unmute.isErr()) {
                  unmuteError = unmute.error.strError
                  return false
                }
                await campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken)
                return true
              }
            )
            await campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken)
          } catch (error) {
            await campaignSpamReputation.releaseReviewOperation(data.reviewId, reviewToken).catch(() => {})
            logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Failed to release campaign review")
            return { feedback: "Review state is temporarily unavailable" }
          }
          if (releaseResult === "not_released") {
            await campaignSpamReputation.releaseReviewOperation(data.reviewId, reviewToken).catch(() => {})
            return { feedback: unmuteError }
          }

          try {
            await campaignSpamReputation.assertReviewOperation(data.reviewId, reviewToken)
          } catch (error) {
            logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Lost review ownership after release")
            await campaignSpamReputation.releaseReviewOperation(data.reviewId, reviewToken).catch(() => {})
            return { feedback: "Permissions restored; retry to finalize this review" }
          }
          const reviewRecorded = await campaignSpamReputation
            .completeReviewOperation(data.reviewId, reviewToken)
            .catch((error) => {
              logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Failed to complete released review")
              return false
            })
          if (!reviewRecorded) {
            logger.warn({ actorId: data.target.id }, "[CampaignSpam] Review lease expired")
            return { feedback: "Permissions restored; retry to finalize this review" }
          }
          ctx.point.tag("campaign_spam_moderator_feedback", "release")
          logger.info(
            {
              actorId: data.target.id,
              chatId: data.chat.id,
              moderatorId: ctx.from.id,
              reviewId: data.reviewId,
              outcome: releaseResult,
            },
            "[CampaignSpam] Moderator release review completed"
          )
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
          return {
            deleteData: true,
            feedback:
              releaseResult === "stale" ? "A newer review or confirmation superseded this item" : "Member released",
          }
        },
      },
    ],
  ],
  undefined,
  { ttlSeconds: CAMPAIGN_REVIEW_RETENTION_SECONDS }
)

/** Creates a review keyboard whose persisted callback state is authenticated and encrypted. */
export function campaignSpamReviewKeyboard(review: CampaignSpamReview) {
  return campaignSpamReviewMenu(sealCampaignSpamReview(review, campaignSpamConfig.fingerprintSecret))
}
