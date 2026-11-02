import { type Api, GrammyError, InputFile } from "grammy"
import type { InputMediaDocument, Message } from "grammy/types"
import { z } from "zod/v4"
import { wait } from "@/utils/wait"

/** Telegram's limits for bot uploads and captions, and for documents in one media group. */
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_CAPTION_LENGTH = 1024
const MAX_FILES = 10

const isoDate = z.iso.date()

const payloadSchema = z.object({
  chatId: z.number().int(),
  /** The forum topic (`message_thread_id`); null for a chat without topics. */
  topicId: z.number().int().positive().nullable(),
  regulation: z.object({
    /** E.g. "Raccolta dei Regolamenti Interni". */
    title: z.string().trim().min(1),
    kind: z.enum(["approval", "rectification"]),
    /** Who approved or rectified: "Consiglio Direttivo", "Assemblea", "Segretario", "Mario Rossi su delega del Segretario". */
    body: z.string().trim().min(1),
    /** Date of the delibera, or of the rectification, as YYYY-MM-DD. */
    date: isoDate,
    /** Last day to file an opposition or appeal, as YYYY-MM-DD; null when none applies. */
    oppositionDeadline: isoDate.nullable(),
    /** The GitHub release with the official PDF. */
    releaseUrl: z.url({ protocol: /^https$/ }),
  }),
  /** The documents to attach, in display order: the new text first, then the differences. */
  files: z
    .array(
      z.object({
        filename: z.string().trim().min(1),
        // socket.io delivers binary attachments as a Buffer over websocket and as an ArrayBuffer over polling.
        data: z
          .union([z.instanceof(Uint8Array), z.instanceof(ArrayBuffer)])
          .transform((data) => (data instanceof Uint8Array ? data : new Uint8Array(data)))
          .refine((data) => data.byteLength > 0, "file is empty")
          .refine((data) => data.byteLength <= MAX_FILE_BYTES, "file exceeds Telegram's 50 MB upload limit"),
      })
    )
    .min(1)
    .max(MAX_FILES),
})

export type PostRegulationPayload = z.input<typeof payloadSchema>
export type RegulationNotice = z.output<typeof payloadSchema>["regulation"]

/**
 * What the bot answers. `messageIds` lists every message posted, also on failure, since a failure after the
 * text was sent leaves a partial post in the chat.
 */
export type PostRegulationResult =
  | { ok: true; chatId: number; topicId: number | null; messageIds: number[]; sentAt: Date }
  | { ok: false; error: string; messageIds: number[] }

/** The `postRegulation` command the backend sends; to be dropped once `@polinetwork/backend` exports it. */
export type PostRegulationEvents = {
  postRegulation: (data: PostRegulationPayload, cb: (result: PostRegulationResult) => void) => void
}

export type RateLimitRetryOptions = {
  /** Total attempts, the first included. Default 5. */
  maxAttempts?: number
  /** Give up instead of waiting once the waits would add up to more than this. Default 120 s. */
  maxTotalWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Runs `call`, waiting out Telegram's `retry_after` on 429 (Too Many Requests) and trying again.
 * Only 429 is retried: Telegram did not perform the request, so trying again cannot post twice.
 */
export async function retryOnRateLimit<T>(call: () => Promise<T>, options: RateLimitRetryOptions = {}): Promise<T> {
  const { maxAttempts = 5, maxTotalWaitMs = 120_000, sleep = wait } = options
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

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** YYYY-MM-DD to DD/MM/YYYY, as the documents print it. */
const italianDate = (date: string) => date.split("-").reverse().join("/")

/** The announcement, in Telegram HTML. */
export function formatRegulationNotice(notice: RegulationNotice): string {
  const lines =
    notice.kind === "approval"
      ? [
          `📜 <b>${escapeHtml(notice.title)}</b>`,
          "È stata emanata una nuova versione.",
          "",
          `<b>Approvazione:</b> ${escapeHtml(notice.body)}, delibera del ${italianDate(notice.date)}`,
        ]
      : [
          `📜 <b>${escapeHtml(notice.title)}</b>`,
          "È stata emanata una rettifica.",
          "",
          `<b>Rettifica:</b> ${escapeHtml(notice.body)}, il ${italianDate(notice.date)}`,
        ]
  if (notice.oppositionDeadline)
    lines.push(`<b>Opposizioni e ricorsi:</b> entro il ${italianDate(notice.oppositionDeadline)}`)
  lines.push("", `<a href="${escapeHtml(notice.releaseUrl).replaceAll('"', "&quot;")}">Versione ufficiale</a>`)
  return lines.join("\n")
}

/** The length Telegram checks against its caption limit: the text once the HTML is parsed. */
function visibleLength(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
  return text.length
}

function describeError(error: unknown): string {
  if (error instanceof GrammyError) return `${error.method}: ${error.error_code} ${error.description}`
  if (error instanceof z.ZodError) return `invalid payload: ${z.prettifyError(error)}`
  return error instanceof Error ? error.message : String(error)
}

type PostApi = Pick<Api, "sendMessage" | "sendDocument" | "sendMediaGroup">

/**
 * Posts a regulation announcement with its documents: one media group (or one document) with the announcement as
 * caption, or the announcement as a message followed by the documents when it does not fit in a caption.
 */
export async function postRegulation(
  api: PostApi,
  payload: unknown,
  retry: RateLimitRetryOptions = {}
): Promise<PostRegulationResult> {
  const messageIds: number[] = []
  try {
    const { chatId, topicId, regulation, files } = payloadSchema.parse(payload)
    const thread = topicId === null ? {} : { message_thread_id: topicId }
    const text = formatRegulationNotice(regulation)
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
      // In a group of documents each one keeps its own caption: the last one reads as the album's.
      const media = documents.map(
        (media, i): InputMediaDocument =>
          i === documents.length - 1 && caption !== null
            ? { type: "document", media, caption, parse_mode: "HTML" }
            : { type: "document", media }
      )
      record(...(await send(() => api.sendMediaGroup(chatId, media, thread))))
    }

    return { ok: true, chatId, topicId, messageIds, sentAt: new Date() }
  } catch (error) {
    return { ok: false, error: describeError(error), messageIds }
  }
}
