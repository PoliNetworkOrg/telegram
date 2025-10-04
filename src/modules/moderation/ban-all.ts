import { type ConnectionOptions, type FlowJob, FlowProducer, type Job, Queue, Worker } from "bullmq"
import { api } from "@/backend"
import { env } from "@/env"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { throttle } from "@/utils/throttle"
import type { ModuleShared } from "@/utils/types"
import { modules } from ".."
import { type BanAll, type BanAllState, isBanAllState } from "../tg-logger/ban-all"

/**
 * Utility type that get the Worker type for a Job
 */
type WorkerFor<J extends Job> = J extends Job<infer D, infer R, infer C> ? Worker<D, R, C> : never

/**
 * Utility type that get the Job type for a FlowJob
 */
type JobForFlow<J extends FlowJob> = J extends FlowJob
  ? J extends { name: infer N extends string; data: infer D }
    ? Job<D, void, N>
    : never
  : never

/** Configuration for the BanAll queue system */
const CONFIG = {
  ORCHESTRATOR_QUEUE: "[ban_all.orchestrator]",
  EXECUTOR_QUEUE: "[ban_all.exec]",
  UPDATE_MESSAGE_THROTTLE_MS: 5000,
}

/** Possible commands for ban jobs */
type BanJobCommand = "ban" | "unban"
/** Possible commands for ban all jobs, each child will have the equivalent command */
type BanAllCommand = `${BanJobCommand}_all`

/** Data for a single ban job */
type BanJobData = {
  chatId: number
  targetId: number
}

/** Flow description for a single ban job */
interface BanFlow extends FlowJob {
  name: BanJobCommand
  queueName: typeof CONFIG.EXECUTOR_QUEUE
  data: BanJobData
  children?: undefined
}
/** Flow description for a ban all job */
interface BanAllFlow extends FlowJob {
  name: BanAllCommand
  queueName: typeof CONFIG.ORCHESTRATOR_QUEUE
  data: {
    banAll: BanAll // entire BanAll data, to re-render the message with progress
    messageId: number // message ID to update the progress message
  }
  children: BanFlow[]
}

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
    async (job) => {
      switch (job.name) {
        case "ban": {
          const success = await this.shared.api.banChatMember(job.data.chatId, job.data.targetId, {
            revoke_messages: true,
          })
          logger.debug({ chatId: job.data.chatId, targetId: job.data.targetId, success }, "[BanAllQueue] ban result")
          if (!success) {
            throw new Error("Failed to ban user")
          }
          return
        }
        case "unban": {
          const success = await this.shared.api.unbanChatMember(job.data.chatId, job.data.targetId)
          if (!success) {
            throw new Error("Failed to unban user")
          }
          logger.debug({ chatId: job.data.chatId, targetId: job.data.targetId, success }, "[BanAllQueue] unban result")
          return
        }
        default:
          throw new Error("Unknown job command")
      }
    },
    { connection, concurrency: 3 }
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
      const { failed, ignored, processed } = await job.getDependenciesCount()
      logger.info(
        `[BanAllQueue] Finished executing ${job.name} job for target ${job.data.banAll.target.id} in ${processed} chats (ignored: ${ignored}, failed: ${failed})`
      )
    },
    { connection }
  )

  /**
   * Queue used to add new ban jobs, each ban_all command will dispatch a batch in this queue
   */
  private execQueue = new Queue<BanJob>(CONFIG.EXECUTOR_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1000, // start with 1 second
      },
      removeOnComplete: {
        age: 60 * 60, // keep for 1 hour
        count: 1000, // keep only the last 1000
      },
      removeOnFail: {
        age: 24 * 60 * 60, // keep for 24 hours
        count: 1000, // keep only the last 1000
      },
    },
  })

  /** queue for the orchestrator, each ban_all command is a job in this queue */
  private orchestrateQueue = new Queue<BanAllJob>(CONFIG.ORCHESTRATOR_QUEUE, { connection })

  /** Flow producer to create parent/child job batch in a single ban_all command */
  private flowProducer = new FlowProducer({ connection })

  public async initiateBanAll(banAll: BanAll, messageId: number) {
    if (banAll.outcome !== "approved") {
      throw new Error("Cannot initiate ban all for a non-approved BanAll")
    }

    const allGroups = await api.tg.groups.getAll.query()
    const chats = allGroups.map((g) => g.telegramId)
    const banType = banAll.type === "BAN" ? "ban" : "unban"

    const job = await this.flowProducer.add({
      name: `${banType}_all`,
      queueName: CONFIG.ORCHESTRATOR_QUEUE,
      data: { banAll, messageId },
      children: chats.map((chat) => ({
        name: banType,
        queueName: CONFIG.EXECUTOR_QUEUE,
        data: {
          chatId: chat,
          targetId: banAll.target.id,
        },
      })),
    } satisfies BanAllFlow)
    return job
  }

  /**
   * Register event listeners when the module is loaded
   */
  override async start() {
    // set the listener to update the parent job progress
    this.executor.on("completed", async (job) => {
      // this listener recomputes the progress for the parent job every time a child job is completed
      const parentID = job.parent?.id
      if (!parentID) return
      const parent = await this.orchestrateQueue.getJob(parentID)
      if (!parent) return
      const rawNumbers = await parent.getDependenciesCount({
        processed: true,
        failed: true,
        ignored: true,
        unprocessed: true,
      })
      // get child counts
      const { failed, ignored, processed, unprocessed } = {
        failed: 0,
        ignored: 0,
        processed: 0,
        unprocessed: 0,
        ...rawNumbers,
      }

      const successCount = processed - (failed + ignored)
      const total = processed + unprocessed
      await parent.updateProgress({
        jobCount: total,
        successCount,
        failedCount: failed,
      } satisfies BanAllState)
    })

    // throttled call to update the message, to avoid spamming Telegram API
    const updateMessage = throttle((banAll: BanAll, messageId: number) => {
      logger.debug("[BanAllQueue] Updating ban all progress message")
      void modules
        .get("tgLogger")
        .banAllProgress(banAll, messageId)
        .catch(() => {
          logger.warn("[BanAllQueue] Failed to update ban all progress message")
        })
    }, CONFIG.UPDATE_MESSAGE_THROTTLE_MS)

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
      this.execQueue.close(),
      this.orchestrateQueue.close(),
      this.flowProducer.close(),
    ])
  }
}
