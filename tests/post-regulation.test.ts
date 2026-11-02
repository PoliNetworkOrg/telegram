import { GrammyError, InputFile } from "grammy"
import type { InputMediaDocument } from "grammy/types"
import { describe, expect, it, vi } from "vitest"
import {
  formatRegulationNotice,
  type PostRegulationPayload,
  postRegulation,
  type RegulationNotice,
  retryOnRateLimit,
} from "@/modules/post-regulation"

const notice: RegulationNotice = {
  title: "Raccolta dei Regolamenti Interni",
  kind: "approval",
  body: "Consiglio Direttivo",
  date: "2026-10-08",
  oppositionDeadline: "2026-10-18",
  releaseUrl: "https://github.com/PoliNetworkOrg/legal/releases/tag/rri-v2026.10.08",
}

const payload = (overrides: Partial<PostRegulationPayload> = {}): PostRegulationPayload => ({
  chatId: -1001234,
  topicId: 42,
  regulation: notice,
  files: [
    { filename: "rri-v2026.10.08.pdf", data: new Uint8Array([1, 2, 3]) },
    { filename: "rri-v2026.10.08-differenze.pdf", data: new Uint8Array([4, 5]) },
  ],
  ...overrides,
})

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

describe("formatRegulationNotice", () => {
  it("lists title, body, delibera date, opposition deadline and release link in Italian", () => {
    expect(formatRegulationNotice(notice)).toBe(
      [
        "📜 <b>Raccolta dei Regolamenti Interni</b>",
        "È stata emanata una nuova versione.",
        "",
        "<b>Approvazione:</b> Consiglio Direttivo, delibera del 08/10/2026",
        "<b>Opposizioni e ricorsi:</b> entro il 18/10/2026",
        "",
        '<a href="https://github.com/PoliNetworkOrg/legal/releases/tag/rri-v2026.10.08">Versione ufficiale</a>',
      ].join("\n")
    )
  })

  it("words a rectification as such and omits a missing deadline", () => {
    const text = formatRegulationNotice({
      ...notice,
      kind: "rectification",
      body: "Mario Rossi su delega del Segretario",
      oppositionDeadline: null,
    })
    expect(text).toContain("È stata emanata una rettifica.")
    expect(text).toContain("<b>Rettifica:</b> Mario Rossi su delega del Segretario, il 08/10/2026")
    expect(text).not.toContain("Opposizioni")
  })

  it("escapes HTML in every field it is given", () => {
    const text = formatRegulationNotice({
      ...notice,
      title: "A <b> & B",
      body: "<script>",
      releaseUrl: 'https://example.org/?a=1&b="x"',
    })
    expect(text).toContain("<b>A &lt;b&gt; &amp; B</b>")
    expect(text).toContain("&lt;script&gt;")
    expect(text).toContain('href="https://example.org/?a=1&amp;b=&quot;x&quot;"')
  })
})

describe("postRegulation", () => {
  it("posts the documents as one media group in the topic, captioned on the last document", async () => {
    const api = fakeApi()
    const result = await postRegulation(asApi(api), payload())

    expect(result).toMatchObject({ ok: true, chatId: -1001234, topicId: 42, messageIds: [100, 101] })
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(api.sendMediaGroup).toHaveBeenCalledOnce()
    const [chatId, media, other] = api.sendMediaGroup.mock.calls[0] as unknown as [number, InputMediaDocument[], object]
    expect(chatId).toBe(-1001234)
    expect(other).toEqual({ message_thread_id: 42 })
    expect(media).toHaveLength(2)
    expect(media[0]).toEqual({ type: "document", media: expect.any(InputFile) })
    expect((media[0].media as InputFile).filename).toBe("rri-v2026.10.08.pdf")
    expect(media[1]).toMatchObject({
      type: "document",
      caption: formatRegulationNotice(notice),
      parse_mode: "HTML",
    })
    expect((media[1].media as InputFile).filename).toBe("rri-v2026.10.08-differenze.pdf")
  })

  it("posts outside topics when no topic is given", async () => {
    const api = fakeApi()
    await postRegulation(asApi(api), payload({ topicId: null }))
    expect(api.sendMediaGroup.mock.calls[0][2]).toEqual({})
  })

  it("sends a single document with sendDocument, since a media group needs two", async () => {
    const api = fakeApi()
    const result = await postRegulation(
      asApi(api),
      payload({ files: [{ filename: "a.pdf", data: new Uint8Array([1]) }] })
    )
    expect(result).toMatchObject({ ok: true, messageIds: [100] })
    expect(api.sendMediaGroup).not.toHaveBeenCalled()
    expect(api.sendDocument).toHaveBeenCalledWith(-1001234, expect.any(InputFile), {
      message_thread_id: 42,
      caption: formatRegulationNotice(notice),
      parse_mode: "HTML",
    })
  })

  it("accepts files delivered as ArrayBuffer", async () => {
    const api = fakeApi()
    const data = new Uint8Array([9, 8, 7]).buffer
    const result = await postRegulation(asApi(api), payload({ files: [{ filename: "a.pdf", data }] }))
    expect(result.ok).toBe(true)
  })

  it("sends the text as its own message when it does not fit in a caption", async () => {
    const api = fakeApi()
    const result = await postRegulation(asApi(api), payload({ regulation: { ...notice, title: "x".repeat(1100) } }))

    expect(result).toMatchObject({ ok: true, messageIds: [100, 101, 102] })
    expect(api.sendMessage).toHaveBeenCalledWith(-1001234, expect.stringContaining("x".repeat(1100)), {
      message_thread_id: 42,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    })
    const media = api.sendMediaGroup.mock.calls[0][1] as InputMediaDocument[]
    expect(media.every((m) => !("caption" in m))).toBe(true)
  })

  it("counts the caption limit on the visible text, not the HTML", async () => {
    const api = fakeApi()
    // The HTML is longer than 1024 characters, the text Telegram counts is not.
    await postRegulation(asApi(api), payload({ regulation: { ...notice, title: "&".repeat(800) } }))
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it("waits out a rate limit and tries again", async () => {
    const api = fakeApi()
    api.sendMediaGroup.mockRejectedValueOnce(rateLimited("sendMediaGroup", 7))
    const sleep = vi.fn(async () => {})

    const result = await postRegulation(asApi(api), payload(), { sleep })

    expect(result).toMatchObject({ ok: true, messageIds: [100, 101] })
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

    const result = await postRegulation(asApi(api), payload({ regulation: { ...notice, title: "x".repeat(1100) } }))

    expect(result).toEqual({
      ok: false,
      error: "sendMediaGroup: 400 Bad Request: file too big",
      messageIds: [100],
    })
  })

  it.each([
    ["no files", { files: [] }],
    [
      "more than ten files",
      { files: Array.from({ length: 11 }, () => ({ filename: "a.pdf", data: new Uint8Array([1]) })) },
    ],
    ["an empty file", { files: [{ filename: "a.pdf", data: new Uint8Array() }] }],
    ["a file over 50 MB", { files: [{ filename: "a.pdf", data: new Uint8Array(50 * 1024 * 1024 + 1) }] }],
    ["a malformed date", { regulation: { ...notice, date: "08/10/2026" } }],
    ["a non-https release link", { regulation: { ...notice, releaseUrl: "javascript:alert(1)" } }],
    ["a missing topic field", { topicId: undefined as unknown as null }],
  ])("refuses %s without calling Telegram", async (_, overrides) => {
    const api = fakeApi()
    const result = await postRegulation(asApi(api), payload(overrides as Partial<PostRegulationPayload>))

    expect(result).toMatchObject({ ok: false, messageIds: [] })
    expect(result.ok || result.error).toMatch(/^invalid payload/)
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

  it("does not wait past the total budget", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(rateLimited("sendMessage", 60))
      .mockRejectedValue(rateLimited("sendMessage", 61))
    const sleep = vi.fn(async () => {})
    await expect(retryOnRateLimit(call, { maxTotalWaitMs: 120_000, sleep })).rejects.toBeInstanceOf(GrammyError)
    expect(sleep).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledTimes(2)
  })
})
