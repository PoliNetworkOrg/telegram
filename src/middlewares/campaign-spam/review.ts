import type { Chat, User } from "grammy/types"
import { MenuGenerator } from "@/lib/menu"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { fmt, fmtChat, fmtUser } from "@/utils/format"
import type { Context } from "@/utils/types"
import type { CampaignSpamReason } from "./classifier"
import { type CampaignConfirmationSignals, campaignActorFromUser } from "./reputation"
import { campaignSpamReputation } from "./service"

export type CampaignSpamReview = {
  source: "join_request" | "message"
  target: User
  chat: Chat
  reasons: CampaignSpamReason[]
  signals?: CampaignConfirmationSignals
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

export const campaignSpamReviewMenu = MenuGenerator.getInstance<Context>().create<CampaignSpamReview>(
  "campaign-spam-review",
  [
    [
      {
        text: "Confirm BanAll",
        cb: async ({ data, ctx }) => {
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
        cb: async ({ data, ctx }) => {
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
  ]
)
