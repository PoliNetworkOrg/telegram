import { type ConnectionOptions, FlowProducer, type Job, Queue, Worker } from "bullmq"
import { api } from "@/backend"
import { env } from "@/env"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { throttleByKey } from "@/utils/throttle"
import type { ModuleShared } from "@/utils/types"
import { modules } from ".."
import { type BanAll, type BanAllState, isBanAllState } from "../tg-logger/ban-all"
import { Moderation } from "."
import { executeBanAllJob } from "./ban-all-executor"
import { type BanAllFlow, type BanFlow, BAN_ALL_QUEUE_CONFIG as CONFIG, createBanAllFlow } from "./ban-all-flow"

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
    { connection, concurrency: 3, limiter: CONFIG.EXECUTOR_RATE_LIMIT }
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
    { connection }
  )

  /** queue for the orchestrator, each ban_all command is a job in this queue */
  private orchestrateQueue = new Queue<BanAllJob>(CONFIG.ORCHESTRATOR_QUEUE, { connection })

  /** Flow producer to create parent/child job batch in a single ban_all command */
  private flowProducer = new FlowProducer({ connection })

  public async initiateBanAll(banAll: BanAll, messageId: number) {
    const allGroups = await api.tg.groups.getAll.query()
    const chats = allGroups.filter((g) => !g.hide).map((g) => g.telegramId)

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
    const reportProgress = throttleByKey(
      (job: BanJob) => {
        // this listener recomputes the progress for the parent job every time a child job is completed
        const parentID = job.parent?.id
        if (!parentID) return
        void this.orchestrateQueue
          .getJob(parentID)
          .then(async (parent) => {
            if (parent) await parent.updateProgress(await this.getProgress(parent))
          })
          .catch((error) => logger.warn({ error, parentID }, "[BanAllQueue] Failed to report progress"))
      },
      (job) => job.parent?.id ?? job.id,
      CONFIG.PROGRESS_REFRESH_THROTTLE_MS
    )

    this.executor.on("completed", (job) => reportProgress(job))
    this.executor.on("failed", (job) => {
      if (job) void reportProgress(job)
    })

    // throttled call to update the message, to avoid spamming Telegram API
    const updateMessage = throttleByKey(
      (banAll: BanAll, messageId: number) => {
        logger.debug("[BanAllQueue] Updating ban all progress message")
        void modules
          .get("tgLogger")
          .banAllProgress(banAll, messageId)
          .catch((error) => {
            logger.warn({ error }, "[BanAllQueue] Failed to update ban all progress message")
          })
      },
      (_banAll, messageId) => messageId,
      CONFIG.UPDATE_MESSAGE_THROTTLE_MS
    )

    this.orchestrateQueue.on("progress", async (job, progress) => {
      // on progress of a ban_all job (in the orchestrator queue),
      // update the message with the new progress (throttled)
      if (!isBanAllState(progress)) return
      const banAll = { ...job.data.banAll, state: progress }
      updateMessage(banAll, job.data.messageId)
      await job.updateData({ ...job.data, banAll }) // update data just to be sure
    })
  }

  /**
   * Gracefully close all the queues and workers
   */
  override async stop() {
    await Promise.all([
      this.executor.close(),
      this.orchestrator.close(),
      this.orchestrateQueue.close(),
      this.flowProducer.close(),
    ])
  }
}
