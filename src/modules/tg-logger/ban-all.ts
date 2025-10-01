import type { Context } from "grammy"
import type { User } from "grammy/types"
import { type CallbackCtx, MenuGenerator } from "@/lib/menu"
import { logger } from "@/logger"
import { fmt, fmtUser } from "@/utils/format"
import { calculateOutcome, type Outcome, type Vote, type Voter } from "@/utils/vote"

export type BanAll = {
  type: "BAN" | "UNBAN"
  target: User
  reporter: User
  reason: string
  outcome: Outcome
  voters: Voter[]
}

const VOTE_EMOJI: Record<Vote, string> = {
  inFavor: "✅",
  against: "❌",
  abstained: "🫥",
}

const OUTCOME_STR: Record<Outcome, string> = {
  waiting: "⏳ Waiting for votes",
  approved: "✅ APPROVED",
  denied: "❌ DENIED",
}

/**
 * Generate the message text of the BanAll case, based on current voting situation.
 *
 * @param data - The BanAll data including message and reporter.
 * @returns A formatted string of the message text.
 */
export const getBanAllText = (data: BanAll) =>
  fmt(
    ({ n, b, strikethrough }) => [
      data.type === "BAN" ? b`🚨 BAN ALL 🚨` : b`🟢 UN-BAN ALL 🟢`,
      "",
      n`${b`🎯 Target:`} ${fmtUser(data.target)}`,
      n`${b`📣 Reporter:`} ${fmtUser(data.reporter)}`,
      n`${b`📋 Reason:`} ${data.reason}`,
      "",
      b`${OUTCOME_STR[data.outcome]}`,
      "",
      b`Voters`,
      ...data.voters.map((v) =>
        data.outcome !== "waiting" && !v.vote
          ? strikethrough`➖ ${fmtUser(v.user)} ${v.isPresident ? b`PRES` : ""}`
          : n`${v.vote ? VOTE_EMOJI[v.vote] : "⏳"} ${fmtUser(v.user)} ${v.isPresident ? b`PRES` : ""}`
      ),
    ],
    { sep: "\n" }
  )

async function vote<C extends Context>(
  ctx: CallbackCtx<C>,
  data: BanAll,
  vote: Vote
): Promise<{ feedback?: string; newData?: BanAll }> {
  const voterId = ctx.callbackQuery.from.id
  const voter = data.voters.find((v) => v.user.id === voterId)
  if (!voter)
    return {
      feedback: "❌ You cannot vote",
    }
  if (voter.vote !== undefined)
    return {
      feedback: "⚠️ You cannot change your vote!",
    }

  voter.vote = vote
  const outcome = calculateOutcome(data.voters)
  logger.debug({ outcome: data.outcome, voters: data.voters }, "[VOTE] new vote, calculating...")
  if (outcome === null) {
    logger.fatal({ banAll: data }, "ERROR WHILE VOTING FOR BAN_ALL, Outcome is null")
    return {
      feedback: "There was an error, check logs",
    }
  }
  data.outcome = outcome

  // remove buttons if there is an outcome (not waiting)
  const reply_markup = outcome === "waiting" ? ctx.msg?.reply_markup : undefined

  await ctx.editMessageText(getBanAllText(data), { reply_markup }).catch(() => {
    // throws if message is not modified - we don't care
  })

  return {
    newData: data,
    feedback: "✅ Thanks for voting!",
  }
}

/**
 * Interactive menu for handling voting.
 *
 * @param data - {@link BanAll} initial BanAll
 */
export const banAllMenu = MenuGenerator.getInstance<Context>().create<BanAll>("ban-all-voting", [
  [
    {
      text: VOTE_EMOJI.inFavor,
      cb: async ({ ctx, data }) => {
        return await vote(ctx, data, "inFavor")
      },
    },
    {
      text: VOTE_EMOJI.abstained,
      cb: async ({ ctx, data }) => {
        return await vote(ctx, data, "abstained")
      },
    },
    {
      text: VOTE_EMOJI.against,
      cb: async ({ ctx, data }) => {
        return await vote(ctx, data, "against")
      },
    },
  ],
])
