import { type Api, GrammyError, InputFile } from "grammy"
import type { InputMediaDocument, Message } from "grammy/types"
import { z } from "zod/v4"
import { wait } from "@/utils/wait"

/** Telegram's limits for bot uploads and captions, and for documents in one media group. */
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_CAPTION_LENGTH = 1024
const MAX_FILES = 10

/** The backend's `PostRegulation` (`src/websocket/telegram.ts`, PoliNetworkOrg/backend#117). */
export type PostRegulationPayload = {
  chatId: number
  /** Forum topic (`message_thread_id`), or null for a chat without topics. */
  topicId: number | null
  /** Telegram HTML, escaped by the backend. */
  text: string
  /** The fields behind `text`; the bot posts `text` as is. */
  regulation: {
    documentTitle: string
    draftTitle: string
    body: string
    deliberaDate: string
    oppositionDeadline: string | null
    tag: string
    releaseUrl: string
  }
  /**
   * In order: the new official PDF, then the differences PDF. Base64 rather than bytes: the backend's Bun engine does
   * not deliver socket.io binary attachments.
   */
  files: { filename: string; contentType: string; base64: string }[]
  /**
   * The backend's notification id, the same on every retry. Same key, same post: a repeated command gets the first
   * one's answer instead of posting again, whatever else it carries.
   */
  idempotencyKey: string
}

/** The `postRegulation` command; to be dropped once a published `@polinetwork/backend` exports it. */
export type PostRegulationEvents = {
  postRegulation: (data: PostRegulationPayload, cb: (error: string | null, result?: PostedMessages) => void) => void
}

/** The messages posted; on failure, the ones posted before it (a partial post), possibly none. */
export type PostedMessages = { messageIds: number[] }
export type PostRegulationResult = { error: string | null } & PostedMessages

/** Only what the bot uses is checked; `regulation` is the backend's business. */
const payloadSchema = z.object({
  chatId: z.number().int(),
  topicId: z.number().int().positive().nullable(),
  text: z.string().trim().min(1),
  files: z
    .array(
      z
        .object({
          filename: z.string().trim().min(1),
          base64: z
            .base64()
            .transform((base64) => Buffer.from(base64, "base64"))
            .refine((data) => data.byteLength > 0, "file is empty")
            .refine((data) => data.byteLength <= MAX_FILE_BYTES, "file exceeds Telegram's 50 MB upload limit"),
        })
        .transform(({ filename, base64 }) => ({ filename, data: base64 }))
    )
    .min(1)
    .max(MAX_FILES),
  idempotencyKey: z.string().min(1),
})

export type RateLimitRetryOptions = {
  /** Total attempts, the first included. Default 5. */
  maxAttempts?: number
  /**
   * Give up instead of waiting once the waits would add up to more than this. Default 30 s, so that with the uploads
   * the bot answers within the backend's 60 s ack timeout, after which the backend sends the command again.
   */
  maxTotalWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Runs `call`, waiting out Telegram's `retry_after` on 429 (Too Many Requests) and trying again.
 * Only 429 is retried: Telegram did not perform the request, so trying again cannot post twice.
 */
export async function retryOnRateLimit<T>(call: () => Promise<T>, options: RateLimitRetryOptions = {}): Promise<T> {
  const { maxAttempts = 5, maxTotalWaitMs = 30_000, sleep = wait } = options
  let waited = 0
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (!(error instanceof GrammyError) || error.error_code !== 429 || attempt >= maxAttempts) throw error
      const delay = (error.parameters.retry_after ?? 1) * 1000
      if (waited + delay > maxTotalWaitMs) throw error
      waited += delay
      await sleep(delay)
    }
  }
}

/** The length Telegram checks against its caption limit: the text once the HTML is parsed. */
function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(lt|gt|quot|amp|#\d+|#x[\da-f]+);/gi, "_").length
}

function describeError(error: unknown): string {
  if (error instanceof GrammyError) return `${error.method}: ${error.error_code} ${error.description}`
  if (error instanceof z.ZodError) return `invalid payload: ${z.prettifyError(error)}`
  return error instanceof Error ? error.message : String(error)
}

type PostApi = Pick<Api, "sendMessage" | "sendDocument" | "sendMediaGroup">

/**
 * Posts a regulation announcement with its documents: one media group (or one document) with the text as caption,
 * or the text as a message followed by the documents when it does not fit in a caption.
 */
export async function postRegulation(
  api: PostApi,
  payload: unknown,
  retry: RateLimitRetryOptions = {}
): Promise<PostRegulationResult> {
  const messageIds: number[] = []
  try {
    const { chatId, topicId, text, files } = payloadSchema.parse(payload)
    const thread = topicId === null ? {} : { message_thread_id: topicId }
    const caption = visibleLength(text) <= MAX_CAPTION_LENGTH ? text : null
    const send = <T>(call: () => Promise<T>) => retryOnRateLimit(call, retry)
    const record = (...messages: Message[]) => messageIds.push(...messages.map((m) => m.message_id))

    if (caption === null) {
      record(
        await send(() =>
          api.sendMessage(chatId, text, { ...thread, parse_mode: "HTML", link_preview_options: { is_disabled: true } })
        )
      )
    }

    const documents = files.map((file) => new InputFile(file.data, file.filename))
    if (documents.length === 1) {
      record(
        await send(() =>
          api.sendDocument(chatId, documents[0], {
            ...thread,
            ...(caption === null ? {} : { caption, parse_mode: "HTML" }),
          })
        )
      )
    } else {
      // In a group of documents each one keeps its own caption, shown under it: on the last one it reads as the
      // album's, on the first it would sit between the documents.
      const media = documents.map(
        (media, i): InputMediaDocument =>
          i === documents.length - 1 && caption !== null
            ? { type: "document", media, caption, parse_mode: "HTML" }
            : { type: "document", media }
      )
      record(...(await send(() => api.sendMediaGroup(chatId, media, thread))))
    }

    return { error: null, messageIds }
  } catch (error) {
    return { error: describeError(error), messageIds }
  }
}

/**
 * Remembers posts by idempotency key: a command repeated while the first is in flight waits for it, one repeated
 * after a success gets the same message ids. Failures are forgotten so that the backend's retry posts again.
 * Kept in memory: a restart of the bot forgets the keys.
 */
export class IdempotentPosts {
  private readonly posts = new Map<string, Promise<PostRegulationResult>>()

  constructor(private readonly ttlMs = 24 * 60 * 60 * 1000) {}

  run(key: string | undefined, post: () => Promise<PostRegulationResult>): Promise<PostRegulationResult> {
    if (key === undefined) return post()
    const known = this.posts.get(key)
    if (known) return known

    const pending = post().then((result) => {
      if (result.error === null) setTimeout(() => this.posts.delete(key), this.ttlMs).unref()
      else this.posts.delete(key)
      return result
    })
    this.posts.set(key, pending)
    return pending
  }
}
