import { api } from "@/backend"
import { MenuGenerator } from "@/lib/menu"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { fmt, fmtChat, fmtUser } from "@/utils/format"
import type { Context } from "@/utils/types"
import { hasCampaignReviewRole } from "./authorization"
import { campaignActorFromUser } from "./reputation"
import { type CampaignSpamReview, openCampaignSpamReview, sealCampaignSpamReview } from "./review-payload"
import { campaignSpamConfig } from "./runtime-config"
import { campaignSpamReputation } from "./service"

export type { CampaignSpamReview } from "./review-payload"

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
export function campaignSpamReviewText(review: CampaignSpamReview): string {
  return fmt(
    ({ b, code, n }) => [
      b`Campaign spam review`,
      n`${b`Source:`} ${review.source === "message" ? "message quarantine" : "restricted join"}`,
      n`${b`Target:`} ${fmtUser(review.target)}`,
      n`${b`Group:`} ${fmtChat(review.chat)}`,
      n`${b`Reasons:`} ${code`${review.reasons.join(", ")}`}`,
    ],
    { sep: "\n" }
  )
}

const campaignSpamReviewMenu = MenuGenerator.getInstance<Context>().create<string>("campaign-spam-review", [
  [
    {
      text: "Confirm BanAll",
      cb: async ({ data: payload, ctx }) => {
        const access = await authorizeAndOpenReview(ctx.from.id, payload)
        if (!("review" in access)) return access
        const data = access.review

        let claimed = true
        try {
          claimed = await campaignSpamReputation.claimBanAll(data.target.id)
        } catch (error) {
          logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Failed to claim moderator BanAll")
        }
        if (!claimed) return { feedback: "BanAll already started" }

        const localBan = await Moderation.ban(
          data.target,
          data.chat,
          ctx.from,
          null,
          undefined,
          "Campaign spam confirmed by moderator"
        )
        if (localBan.isErr()) {
          await campaignSpamReputation.releaseBanAllClaim(data.target.id).catch(() => {})
          return { feedback: localBan.error.strError }
        }

        try {
          if (data.signals) {
            await campaignSpamReputation.recordConfirmed(data.signals, campaignActorFromUser(data.target))
          } else {
            await campaignSpamReputation.recordDeniedActor(campaignActorFromUser(data.target))
          }
        } catch (error) {
          logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Failed to record moderator confirmation")
        }
        const result = await modules
          .get("tgLogger")
          .banAll(data.target, ctx.from, "BAN", "Campaign spam confirmed by moderator")
        if (!result.started) {
          await campaignSpamReputation.releaseBanAllClaim(data.target.id).catch(() => {})
          return { feedback: result.message }
        }

        ctx.point.tag("campaign_spam_moderator_feedback", "confirm")
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
        return { feedback: "BanAll started" }
      },
    },
    {
      text: "Release",
      cb: async ({ data: payload, ctx }) => {
        const access = await authorizeAndOpenReview(ctx.from.id, payload)
        if (!("review" in access)) return access
        const data = access.review

        const unmute = await Moderation.unmute(data.target, data.chat, ctx.from)
        if (unmute.isErr()) return { feedback: unmute.error.strError }

        try {
          await Promise.all([
            campaignSpamReputation.clearConfirmed(campaignActorFromUser(data.target)),
            campaignSpamReputation.clearPending(data.chat.id, data.target.id),
          ])
        } catch (error) {
          logger.error({ error, actorId: data.target.id }, "[CampaignSpam] Failed to clear released reputation")
          return { feedback: "Permissions restored; reputation cleanup failed. Retry Release." }
        }
        ctx.point.tag("campaign_spam_moderator_feedback", "release")
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
        return { feedback: "Member released" }
      },
    },
  ],
])

/** Creates a review keyboard whose persisted callback state is authenticated and encrypted. */
export function campaignSpamReviewKeyboard(review: CampaignSpamReview) {
  return campaignSpamReviewMenu(sealCampaignSpamReview(review, campaignSpamConfig.fingerprintSecret))
}
