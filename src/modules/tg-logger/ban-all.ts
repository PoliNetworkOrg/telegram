import type { User } from "grammy/types"
import { fmt, fmtUser } from "@/utils/format"
import { unicodeProgressBar } from "@/utils/progress"

// NOTE
// Previously this was using a voting system made in @/utils/vote.ts.
// Since banAll is a urgent moderation action to execute, we decided to remove it,
// giving priority to common sense over formality.
// If in the future we decide to reintroduce it, check the following PR
//  https://github.com/PoliNetworkOrg/telegram/pull/94
// to understand how to reimplement it

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
  target: User | number
  reporter: User
  reason?: string
  state: BanAllState
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
    ({ n, b, skip, i, link }) => [
      data.type === "BAN" ? b`🚨 BAN ALL 🚨` : b`🕊 UN-BAN ALL 🕊`,
      "",
      n`${b`🎯 Target:`} ${typeof data.target === "number" ? link(data.target.toString(), `tg://user?id=${data.target}`) : fmtUser(data.target)} `,
      n`${b`📣 Reporter:`} ${fmtUser(data.reporter)} `,
      data.type === "BAN" ? n`${b`📋 Reason:`} ${data.reason ? data.reason : i`N/A`}` : undefined,
      "",
      skip`${getProgressText(data.state)}`,
      "",
    ],
    { sep: "\n" }
  )
