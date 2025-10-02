import type { Context } from "grammy"
import type { User } from "grammy/types"
import { type CallbackCtx, MenuGenerator } from "@/lib/menu"
import { logger } from "@/logger"
import { fmt, fmtUser } from "@/utils/format"
import { unicodeProgressBar } from "@/utils/progress"
import { calculateOutcome, type Outcome, type Vote, type Voter } from "@/utils/vote"
import { modules } from ".."

export type BanAllState = {
  jobCount: number
  successCount: number
  failedCount: number
}

const spaces = (n: number) => " ".repeat(n)

export function isBanAllState(obj: unknown): obj is BanAllState {
  return !!(
    obj &&
    typeof obj === "object" &&
    "jobCount" in obj &&
    "successCount" in obj &&
    "failedCount" in obj &&
    typeof obj.jobCount === "number" &&
    typeof obj.successCount === "number" &&
    typeof obj.failedCount === "number"
  )
}

export type BanAll = {
  type: "BAN" | "UNBAN"
  target: User
  reporter: User
  reason?: string
  outcome: Outcome
  voters: Voter[]
  state: BanAllState
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

export const getProgressText = (state: BanAll["state"]): string => {
  if (state.jobCount === 0) return fmt(({ i }) => i`\nFetching groups...`)

  const progress = (state.successCount + state.failedCount) / state.jobCount
  const percent = (progress * 100).toFixed(1)
  const barLength = 18

  const stateEmoji = `🟢 ${state.successCount}${spaces(10)}🔴 ${state.failedCount}${spaces(10)}⏸️ ${state.jobCount - state.successCount - state.failedCount}`
  return fmt(
    ({ n, b, i }) => [
      n`\n${b`Progress`} ${i`(${state.jobCount} groups)`}`,
      n`${unicodeProgressBar(progress, barLength)} ${percent}% `,
      n`${stateEmoji}`,
    ],
    { sep: "\n" }
  )
}

/**
 * Generate the message text of the BanAll case, based on current voting situation.
 *
 * @param data - The BanAll data including message and reporter.
 * @returns A formatted string of the message text.
 */
export const getBanAllText = (data: BanAll) =>
  fmt(
    ({ n, b, skip, strikethrough, i }) => [
      data.type === "BAN" ? b`🚨 BAN ALL 🚨` : b`🕊 UN-BAN ALL 🕊`,
      "",
      n`${b`🎯 Target:`} ${fmtUser(data.target)} `,
      n`${b`📣 Reporter:`} ${fmtUser(data.reporter)} `,
      data.type === "BAN" ? n`${b`📋 Reason:`} ${data.reason ? data.reason : i`N/A`}` : undefined,
      "",
      b`${OUTCOME_STR[data.outcome]} `,
      data.outcome === "approved" ? skip`${getProgressText(data.state)}` : undefined,
      "",
      b`Voters`,
      ...data.voters.map((v) =>
        data.outcome !== "waiting" && !v.vote
          ? strikethrough`➖ ${fmtUser(v.user)} ${v.isPresident ? b`PRES` : ""} `
          : n`${v.vote ? VOTE_EMOJI[v.vote] : "⏳"} ${fmtUser(v.user)} ${v.isPresident ? b`PRES` : ""} `
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

  if (outcome === "approved") {
    try {
      if (ctx.msgId) await modules.get("banAll").initiateBanAll(data, ctx.msgId)
      else {
        logger.error(
          { callbackQuery: ctx.callbackQuery },
          "Message ID is undefined, cannot initiate ban all. How did this happen?"
        )
      }
    } catch (error) {
      await modules
        .get("tgLogger")
        .exception({ error, type: "UNKNOWN" }, "There was an error while initializing BanAll queue, check logs")
    }
  }

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
