import { GrammyError, InputFile } from "grammy"
import type { InputMediaDocument } from "grammy/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  IdempotentPosts,
  type PostRegulationPayload,
  type PostRegulationResult,
  postRegulation,
  retryOnRateLimit,
} from "@/modules/post-regulation"

const text = [
  "📜 <b>Raccolta dei Regolamenti Interni</b>",
  "Approvata dal Consiglio Direttivo il 08/10/2026.",
  'Opposizioni e ricorsi entro il 28/10/2026. <a href="https://github.com/PoliNetworkOrg/legal/releases/tag/rri-v2026.10.08">Release</a>',
].join("\n")

const b64 = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString("base64")

const payload = (overrides: Partial<PostRegulationPayload> = {}): PostRegulationPayload => ({
  chatId: -1001234,
  topicId: 42,
  text,
  regulation: {
    documentTitle: "Raccolta dei Regolamenti Interni",
    draftTitle: "Riforma dei gruppi",
    body: "Consiglio Direttivo",
    deliberaDate: "2026-10-08",
    oppositionDeadline: "2026-10-28",
    tag: "rri-v2026.10.08",
    releaseUrl: "https://github.com/PoliNetworkOrg/legal/releases/tag/rri-v2026.10.08",
  },
  files: [
    { filename: "rri-v2026.10.08.pdf", contentType: "application/pdf", base64: b64([1, 2, 3]) },
    { filename: "differenze-rri-v2026.10.08.pdf", contentType: "application/pdf", base64: b64([4, 5]) },
  ],
  idempotencyKey: "notification-1",
  ...overrides,
})

const pdf = (base64: string) => ({ filename: "a.pdf", contentType: "application/pdf", base64 })

const rateLimited = (method: string, retryAfter: number) =>
  new GrammyError(
    "Too Many Requests",
    {
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfter}`,
      parameters: { retry_after: retryAfter },
    },
    method,
    {}
  )

function fakeApi() {
  let nextId = 100
  return {
    sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
    sendDocument: vi.fn(async () => ({ message_id: nextId++ })),
    sendMediaGroup: vi.fn(async (_chat: number, media: unknown[], _other?: object) =>
      media.map(() => ({ message_id: nextId++ }))
    ),
  }
}

/** The fake only returns the message ids the code reads. */
const asApi = (api: ReturnType<typeof fakeApi>) => api as unknown as Parameters<typeof postRegulation>[0]

describe("postRegulation", () => {
  it("posts the documents as one media group in the topic, the text as caption of the last one", async () => {
    const api = fakeApi()
    const result = await postRegulation(asApi(api), payload())

    expect(result).toEqual({ error: null, messageIds: [100, 101] })
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(api.sendMediaGroup).toHaveBeenCalledOnce()
    const [chatId, media, other] = api.sendMediaGroup.mock.calls[0] as unknown as [number, InputMediaDocument[], object]
    expect(chatId).toBe(-1001234)
    expect(other).toEqual({ message_thread_id: 42 })
    expect(media).toHaveLength(2)
    expect(media[0]).toEqual({ type: "document", media: expect.any(InputFile) })
    expect((media[0].media as InputFile).filename).toBe("rri-v2026.10.08.pdf")
    expect(media[1]).toMatchObject({ type: "document", caption: text, parse_mode: "HTML" })
    expect((media[1].media as InputFile).filename).toBe("differenze-rri-v2026.10.08.pdf")
  })

  it("posts outside topics when no topic is given", async () => {
    const api = fakeApi()
    await postRegulation(asApi(api), payload({ topicId: null }))
    expect(api.sendMediaGroup.mock.calls[0][2]).toEqual({})
  })

  it("sends a single document with sendDocument, since a media group needs two", async () => {
    const api = fakeApi()
    const result = await postRegulation(asApi(api), payload({ files: [pdf(b64([1]))] }))
    expect(result).toEqual({ error: null, messageIds: [100] })
    expect(api.sendMediaGroup).not.toHaveBeenCalled()
    expect(api.sendDocument).toHaveBeenCalledWith(-1001234, expect.any(InputFile), {
      message_thread_id: 42,
      caption: text,
      parse_mode: "HTML",
    })
  })

  it("uploads the bytes the base64 encodes", async () => {
    const api = fakeApi()
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256)
    await postRegulation(asApi(api), payload({ files: [pdf(b64(bytes))] }))
    const file = api.sendDocument.mock.calls[0] as unknown as [number, InputFile]
    expect(new Uint8Array((await file[1].toRaw()) as Uint8Array)).toEqual(bytes)
  })

  it("sends the text as its own message when it does not fit in a caption", async () => {
    const api = fakeApi()
    const long = `<b>${"x".repeat(1100)}</b>`
    const result = await postRegulation(asApi(api), payload({ text: long }))

    expect(result).toEqual({ error: null, messageIds: [100, 101, 102] })
    expect(api.sendMessage).toHaveBeenCalledWith(-1001234, long, {
      message_thread_id: 42,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    })
    const media = api.sendMediaGroup.mock.calls[0][1] as InputMediaDocument[]
    expect(media.every((m) => !("caption" in m))).toBe(true)
  })

  it("counts the caption limit on the visible text, not the HTML", async () => {
    const api = fakeApi()
    // 800 entities are 4000 characters of HTML but 800 of text.
    await postRegulation(asApi(api), payload({ text: `<b>${"&amp;".repeat(800)}</b>` }))
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it("waits out a rate limit and tries again", async () => {
    const api = fakeApi()
    api.sendMediaGroup.mockRejectedValueOnce(rateLimited("sendMediaGroup", 7))
    const sleep = vi.fn(async () => {})

    const result = await postRegulation(asApi(api), payload(), { sleep })

    expect(result).toEqual({ error: null, messageIds: [100, 101] })
    expect(sleep).toHaveBeenCalledWith(7000)
    expect(api.sendMediaGroup).toHaveBeenCalledTimes(2)
  })

  it("reports the messages already posted when a later call fails", async () => {
    const api = fakeApi()
    api.sendMediaGroup.mockRejectedValueOnce(
      new GrammyError(
        "Bad Request",
        { ok: false, error_code: 400, description: "Bad Request: file too big" },
        "sendMediaGroup",
        {}
      )
    )

    const result = await postRegulation(asApi(api), payload({ text: "x".repeat(1100) }))

    expect(result).toEqual({ error: "sendMediaGroup: 400 Bad Request: file too big", messageIds: [100] })
  })

  it.each([
    ["no files", { files: [] }],
    ["more than ten files", { files: Array.from({ length: 11 }, () => pdf(b64([1]))) }],
    ["an empty file", { files: [pdf("")] }],
    ["a file that is not base64", { files: [pdf("not base64!")] }],
    ["a file over 50 MB", { files: [pdf(Buffer.alloc(50 * 1024 * 1024 + 1).toString("base64"))] }],
    ["a missing idempotency key", { idempotencyKey: "" }],
    ["an empty text", { text: "  " }],
    ["a missing topic field", { topicId: undefined as unknown as null }],
  ])("refuses %s without calling Telegram", async (_, overrides) => {
    const api = fakeApi()
    const result = await postRegulation(asApi(api), payload(overrides as Partial<PostRegulationPayload>))

    expect(result.messageIds).toEqual([])
    expect(result.error).toMatch(/^invalid payload/)
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(api.sendDocument).not.toHaveBeenCalled()
    expect(api.sendMediaGroup).not.toHaveBeenCalled()
  })
})

describe("retryOnRateLimit", () => {
  it("retries only 429 errors", async () => {
    const call = vi.fn().mockRejectedValue(new Error("network down"))
    await expect(retryOnRateLimit(call, { sleep: async () => {} })).rejects.toThrow("network down")
    expect(call).toHaveBeenCalledOnce()
  })

  it("gives up after the attempts allowed", async () => {
    const call = vi.fn().mockRejectedValue(rateLimited("sendMessage", 1))
    const sleep = vi.fn(async () => {})
    await expect(retryOnRateLimit(call, { maxAttempts: 3, sleep })).rejects.toBeInstanceOf(GrammyError)
    expect(call).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it("does not wait past 30 s in total by default, inside the backend's 60 s ack timeout", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(rateLimited("sendMessage", 20))
      .mockRejectedValue(rateLimited("sendMessage", 11))
    const sleep = vi.fn(async () => {})
    await expect(retryOnRateLimit(call, { sleep })).rejects.toBeInstanceOf(GrammyError)
    expect(sleep).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe("IdempotentPosts", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const ok: PostRegulationResult = { error: null, messageIds: [1, 2] }
  const failed: PostRegulationResult = { error: "boom", messageIds: [] }

  it("lets a command repeated while the first is in flight wait for it", async () => {
    const posts = new IdempotentPosts()
    let finish: (r: PostRegulationResult) => void = () => {}
    const post = vi.fn(
      () =>
        new Promise<PostRegulationResult>((r) => {
          finish = r
        })
    )

    const first = posts.run("k", post)
    const second = posts.run("k", post)
    finish(ok)

    expect(await first).toEqual(ok)
    expect(await second).toEqual(ok)
    expect(post).toHaveBeenCalledOnce()
  })

  it("answers a repeat after a success with the same messages, until the TTL", async () => {
    vi.useFakeTimers()
    const posts = new IdempotentPosts(1000)
    const post = vi.fn(async () => ok)

    await posts.run("k", post)
    expect(await posts.run("k", post)).toEqual(ok)
    expect(post).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(1000)
    await posts.run("k", post)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it("forgets failures so that a retry posts again", async () => {
    const posts = new IdempotentPosts()
    const post = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(ok)

    expect(await posts.run("k", post)).toEqual(failed)
    expect(await posts.run("k", post)).toEqual(ok)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it("does not dedupe without a key or across keys", async () => {
    const posts = new IdempotentPosts()
    const post = vi.fn(async () => ok)

    await posts.run(undefined, post)
    await posts.run(undefined, post)
    await posts.run("a", post)
    await posts.run("b", post)
    expect(post).toHaveBeenCalledTimes(4)
  })
})
