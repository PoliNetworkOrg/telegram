import { type ConnectionOptions, FlowProducer, type Job, Queue, Worker } from "bullmq"
import { api } from "@/backend"
import { env } from "@/env"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { serialize } from "@/utils/serialize"
import { throttleAsyncByKey } from "@/utils/throttle"
import type { ModuleShared } from "@/utils/types"
import { modules } from ".."
import { type BanAll, type BanAllState, isBanAllState } from "../tg-logger/ban-all"
import { Moderation } from "."
import { executeBanAllJob } from "./ban-all-executor"
import {
  assertBanAllQueueCapacity,
  type BanAllFlow,
  type BanFlow,
  BAN_ALL_QUEUE_CONFIG as CONFIG,
  createBanAllFlow,
} from "./ban-all-flow"

/**
 * Utility type that get the Worker type for a Job
 */
type WorkerFor<J extends Job> = J extends Job<infer D, infer R, infer C> ? Worker<D, R, C> : never

type JobForFlow<J extends { name: string; data?: unknown }> = J extends {
  name: infer N extends string
  data: infer D
}
  ? Job<D, void, N>
  : never

/** Job type for a single ban job */
type BanJob = JobForFlow<BanFlow>
/** Job type for a ban all job, only executed when all child jobs are completed (every ban executed) */
type BanAllJob = JobForFlow<BanAllFlow>

// redis connection options
const connection: ConnectionOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  username: env.REDIS_USERNAME,
  password: env.REDIS_PASSWORD,
}

/**
 * # BanAll Queue
 *
 * ### A queue system to handle `/ban_all` commands.
 *
 * Each command is a job in the orchestrator queue, which spawns a child job for
 * each PoliNetwork group in the executor queue.
 *
 * - [X] **Completely persistent**: all jobs are stored in Redis
 * - [X] **Resilient to crashes**: if the bot crashes or is restarted,
 * both jobs and side-effects will continue from where they left off
 * - [X] **Atomicity**: `ban_all`s are guaranteed to only be marked as completed
 * when all bans are executed
 */
export class BanAllQueue extends Module<ModuleShared> {
  /**
   * Worker that executes the actual ban/unban commands
   *
   * Has no context about the ban all, just executes the commands it receives
   */
  private executor: WorkerFor<BanJob> = new Worker(
    CONFIG.EXECUTOR_QUEUE,
    async (job) =>
      executeBanAllJob(this.shared.api, job, (userId, chatId) =>
        Moderation.deleteAllLastMessages(userId, chatId, { requireSuccess: true })
      ),
    { connection, concurrency: 3, limiter: CONFIG.EXECUTOR_RATE_LIMIT, autorun: false }
  )

  /**
   * Worker that orchestrates the ban all jobs
   *
   * Listens for completed child jobs and updates the parent job progress
   * When all child jobs are completed, the parent job is marked as completed
   */
  private orchestrator: WorkerFor<BanAllJob> = new Worker(
    CONFIG.ORCHESTRATOR_QUEUE,
    async (job) => {
      const state = await this.getProgress(job)
      await job.updateProgress(state)
      logger.info(
        `[BanAllQueue] Finished executing ${job.name} job for target ${typeof job.data.banAll.target === "number" ? job.data.banAll.target : job.data.banAll.target.id} in ${state.successCount} chats (failed: ${state.failedCount})`
      )
    },
    { connection, autorun: false }
  )

  /** queue for the orchestrator, each ban_all command is a job in this queue */
  private orchestrateQueue = new Queue<BanAllJob>(CONFIG.ORCHESTRATOR_QUEUE, { connection })

  /** queue used to inspect executor backlog before accepting another flow */
  private execQueue = new Queue<BanJob>(CONFIG.EXECUTOR_QUEUE, { connection })

  /** Flow producer to create parent/child job batch in a single ban_all command */
  private flowProducer = new FlowProducer({ connection })

  private enqueueBanAll = serialize(async (banAll: BanAll, messageId: number) => {
    const allGroups = await api.tg.groups.getAll.query()
    const chats = allGroups.filter((g) => !g.hide).map((g) => g.telegramId)
    const outstandingJobs = await this.execQueue.getJobCountByTypes(
      "active",
      "waiting",
      "paused",
      "delayed",
      "prioritized"
    )
    assertBanAllQueueCapacity(outstandingJobs, chats.length)

    await api.tg.auditLog.create
      .mutate({
        adminId: banAll.reporter.id,
        targetId: typeof banAll.target === "number" ? banAll.target : banAll.target.id,
        type: banAll.type === "BAN" ? "ban_all" : "unban_all",
        reason: banAll.reason,
        groupId: null,
        until: null,
      })
      .catch(() => {
        logger.warn("[BanAllQueue] Failed to create audit log for ban all command")
      })

    const job = await this.flowProducer.add(createBanAllFlow(banAll, messageId, chats))
    return job
  })

  public async initiateBanAll(banAll: BanAll, messageId: number) {
    return await this.enqueueBanAll(banAll, messageId)
  }

  private async getProgress(job: BanAllJob): Promise<BanAllState> {
    const counts = await job.getDependenciesCount({
      processed: true,
      failed: true,
      ignored: true,
      unprocessed: true,
    })
    const { failed = 0, ignored = 0, processed = 0, unprocessed = 0 } = counts

    return {
      jobCount: processed + unprocessed + ignored + failed,
      successCount: processed,
      failedCount: failed + ignored,
    }
  }

  /**
   * Register event listeners when the module is loaded
   */
  override async start() {
    const reportProgress = throttleAsyncByKey(
      async (job: BanJob) => {
        // this listener recomputes the progress for the parent job every time a child job is completed
        const parentID = job.parent?.id
        if (!parentID) return
        const parent = await this.orchestrateQueue.getJob(parentID)
        if (parent) await parent.updateProgress(await this.getProgress(parent))
      },
      (job) => job.parent?.id ?? job.id,
      CONFIG.PROGRESS_REFRESH_THROTTLE_MS,
      (error, parentID) => logger.warn({ error, parentID }, "[BanAllQueue] Failed to report progress")
    )

    this.executor.on("completed", (job) => reportProgress(job))
    this.executor.on("failed", (job) => {
      if (job) void reportProgress(job)
    })

    // throttled call to update the message, to avoid spamming Telegram API
    const updateMessage = throttleAsyncByKey(
      async (job: BanAllJob, progress: BanAllState) => {
        logger.debug("[BanAllQueue] Updating ban all progress message")
        const banAll = { ...job.data.banAll, state: progress }
        const results = await Promise.allSettled([
          modules.get("tgLogger").banAllProgress(banAll, job.data.messageId),
          job.updateData({ ...job.data, banAll }),
        ])
        const failure = results.find((result) => result.status === "rejected")
        if (failure) throw failure.reason
      },
      (job) => job.id,
      CONFIG.UPDATE_MESSAGE_THROTTLE_MS,
      (error, jobId) => logger.warn({ error, jobId }, "[BanAllQueue] Failed to update ban all progress message")
    )

    const handleProgress = (job: BanAllJob, progress: unknown) => {
      // on progress of a ban_all job (in the orchestrator queue),
      // update the message with the new progress (throttled)
      if (!isBanAllState(progress)) return
      updateMessage(job, progress)
    }

    this.orchestrateQueue.on("progress", handleProgress)
    this.orchestrator.on("progress", handleProgress)
    this.executor.on("error", (error) => logger.error({ error }, "[BanAllQueue] Executor worker error"))
    this.orchestrator.on("error", (error) => logger.error({ error }, "[BanAllQueue] Orchestrator worker error"))

    void this.executor.run().catch((error) => logger.error({ error }, "[BanAllQueue] Executor stopped"))
    void this.orchestrator.run().catch((error) => logger.error({ error }, "[BanAllQueue] Orchestrator stopped"))
  }

  /**
   * Gracefully close all the queues and workers
   */
  override async stop() {
    await Promise.all([
      this.executor.close(),
      this.orchestrator.close(),
      this.execQueue.close(),
      this.orchestrateQueue.close(),
      this.flowProducer.close(),
    ])
  }
}
