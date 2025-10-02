import { type ConnectionOptions, type FlowJob, FlowProducer, type Job, Queue, Worker } from "bullmq"
import { api } from "@/backend"
import { env } from "@/env"
import { Module } from "@/lib/modules"
import { logger } from "@/logger"
import { throttle } from "@/utils/throttle"
import type { ModuleShared } from "@/utils/types"
import { modules } from ".."
import { type BanAll, type BanAllState, isBanAllState } from "../tg-logger/ban-all"

const CONFIG = {
  ORCHESTRATOR_QUEUE: "[ban_all.orchestrator]",
  EXECUTOR_QUEUE: "[ban_all.exec]",
  UPDATE_MESSAGE_THROTTLE_MS: 5000,
}

type BanJobData = {
  chatId: number
  targetId: number
}

type BanJobCommand = "ban" | "unban"
type BanAllCommand = `${BanJobCommand}_all`

type BanJob = Job<BanJobData, void, BanJobCommand>
type JobForFlow<J extends FlowJob> = J extends FlowJob
  ? J extends { name: infer N extends string; data: infer D }
    ? Job<D, void, N>
    : never
  : never

type WorkerFor<J extends Job | FlowJob> = J extends Job<infer D, infer R, infer C>
  ? Worker<D, R, C>
  : J extends FlowJob
    ? Worker<J["data"], void, J["name"]>
    : never
interface BanFlowJob extends FlowJob {
  name: BanJobCommand
  queueName: typeof CONFIG.EXECUTOR_QUEUE
  data: BanJobData
  children?: undefined
}
interface BanAllFlowJob extends FlowJob {
  name: BanAllCommand
  queueName: typeof CONFIG.ORCHESTRATOR_QUEUE
  data: {
    banAll: BanAll
    messageId: number
  }
  children: BanFlowJob[]
}

const connection: ConnectionOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  username: env.REDIS_USERNAME,
  password: env.REDIS_PASSWORD,
}

export class BanAllQueue extends Module<ModuleShared> {
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

  private orchestrator: WorkerFor<BanAllFlowJob> = new Worker(
    CONFIG.ORCHESTRATOR_QUEUE,
    async (job) => {
      const { failed, ignored, processed } = await job.getDependenciesCount()
      logger.info(
        `[BanAllQueue] Finished executing ${job.name} job for target ${job.data.banAll.target.id} in ${processed} chats (ignored: ${ignored}, failed: ${failed})`
      )
    },
    { connection }
  )

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

  private orchestrateQueue = new Queue<JobForFlow<BanAllFlowJob>>(CONFIG.ORCHESTRATOR_QUEUE, { connection })

  private flowProducer = new FlowProducer({ connection })

  public async progress(targetId: number) {
    const jobs = await this.orchestrateQueue.getJobs([])
    const job = jobs.find((j) => j.data.banAll.target.id === targetId)
    if (!job) return null
    const { failed, ignored, processed } = await job.getDependenciesCount()
    return { failed, ignored, processed }
  }

  override async start() {
    // set the listener to update the parent job progress
    this.executor.on("completed", async (job) => {
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
      const { failed, ignored, processed, unprocessed } = {
        failed: 0,
        ignored: 0,
        processed: 0,
        unprocessed: 0,
        ...rawNumbers,
      }

      const completed = processed - (failed + ignored)
      const total = processed + unprocessed
      await parent.updateProgress({
        successCount: completed,
        jobCount: total,
        failedCount: failed,
      } satisfies BanAllState)
    })

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
      if (!isBanAllState(progress)) return
      const banAll = { ...job.data.banAll, state: progress }
      updateMessage(banAll, job.data.messageId)
      await job.updateData({ ...job.data, banAll })
    })
  }

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
    } satisfies BanAllFlowJob)
    return job
  }

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
