import type { FlowJob, JobsOptions } from "bullmq"
import type { BanAll } from "../tg-logger/ban-all"

export const BAN_ALL_QUEUE_CONFIG = {
  ORCHESTRATOR_QUEUE: "[ban_all.orchestrator]",
  EXECUTOR_QUEUE: "[ban_all.exec]",
  PROGRESS_REFRESH_THROTTLE_MS: 1000,
  UPDATE_MESSAGE_THROTTLE_MS: 5000,
  EXECUTOR_RATE_LIMIT: {
    max: 12,
    duration: 1000,
  },
  // Supports about 92 full 648-chat flows while limiting first-attempt starts
  // to about 83 minutes of work at the configured rate.
  MAX_OUTSTANDING_EXECUTOR_JOBS: 60_000,
} as const

export type BanJobCommand = "ban" | "unban"
export type BanAllCommand = `${BanJobCommand}_all`

export type BanJobData = {
  chatId: number
  targetId: number
}

export interface BanFlow extends FlowJob {
  name: BanJobCommand
  queueName: typeof BAN_ALL_QUEUE_CONFIG.EXECUTOR_QUEUE
  data: BanJobData
  children?: undefined
}

export interface BanAllFlow extends FlowJob {
  name: BanAllCommand
  queueName: typeof BAN_ALL_QUEUE_CONFIG.ORCHESTRATOR_QUEUE
  data: {
    banAll: BanAll
    messageId: number
  }
  children: BanFlow[]
}

const RETRY_OPTIONS = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 1000,
  },
} satisfies JobsOptions

const PARENT_OPTIONS = {
  ...RETRY_OPTIONS,
  removeOnComplete: {
    age: 60 * 60,
    count: 1000,
  },
  removeOnFail: {
    age: 24 * 60 * 60,
    count: 1000,
  },
} satisfies JobsOptions

const CHILD_OPTIONS = {
  ...RETRY_OPTIONS,
  ignoreDependencyOnFailure: true,
  removeOnComplete: {
    age: 60 * 60,
    // The worker can finish at most 43,200 jobs per hour at its configured
    // rate. This cap bounds Redis without removing dependencies mid-flow.
    count: 50_000,
  },
  removeOnFail: {
    age: 24 * 60 * 60,
    count: 5_000,
  },
} satisfies JobsOptions

export class BanAllQueueCapacityError extends Error {
  constructor(
    readonly outstandingJobs: number,
    readonly requestedJobs: number,
    readonly maximumJobs: number
  ) {
    super(
      `BanAll queue capacity exceeded: ${outstandingJobs} outstanding, ${requestedJobs} requested, ${maximumJobs} maximum`
    )
    this.name = "BanAllQueueCapacityError"
  }
}

export function assertBanAllQueueCapacity(outstandingJobs: number, requestedJobs: number): void {
  const maximumJobs = BAN_ALL_QUEUE_CONFIG.MAX_OUTSTANDING_EXECUTOR_JOBS
  if (requestedJobs <= maximumJobs - outstandingJobs) return
  throw new BanAllQueueCapacityError(outstandingJobs, requestedJobs, maximumJobs)
}

/** Creates a stable parent job ID for retry-safe network moderation. */
export function banAllFlowId(type: BanAll["type"], idempotencyKey: string): string {
  return `ban-all-${type.toLowerCase()}-${idempotencyKey}`
}

/** Builds a BanAll flow and deterministic child IDs when retry deduplication is requested. */
export function createBanAllFlow(
  banAll: BanAll,
  messageId: number,
  chats: number[],
  idempotencyKey?: string
): BanAllFlow {
  const banType = banAll.type === "BAN" ? "ban" : "unban"
  const targetId = typeof banAll.target === "number" ? banAll.target : banAll.target.id
  const parentJobId = idempotencyKey ? banAllFlowId(banAll.type, idempotencyKey) : undefined
  const parentOptions = parentJobId
    ? {
        ...PARENT_OPTIONS,
        jobId: parentJobId,
        removeOnComplete: { age: 60 * 60 * 24 * 30 },
      }
    : PARENT_OPTIONS

  return {
    name: `${banType}_all`,
    queueName: BAN_ALL_QUEUE_CONFIG.ORCHESTRATOR_QUEUE,
    data: { banAll, messageId },
    opts: parentOptions,
    children: chats.map((chatId) => ({
      name: banType,
      queueName: BAN_ALL_QUEUE_CONFIG.EXECUTOR_QUEUE,
      opts: parentJobId
        ? { ...CHILD_OPTIONS, jobId: `${parentJobId}-${String(chatId).replace("-", "n")}` }
        : CHILD_OPTIONS,
      data: { chatId, targetId },
    })),
  }
}
