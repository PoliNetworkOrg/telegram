import { beforeEach, describe, expect, it } from "vitest"
import {
  buttonDomainFingerprint,
  extractCampaignSignals,
  handleFingerprint,
} from "@/middlewares/campaign-spam/classifier"
import type { CampaignSpamConfig } from "@/middlewares/campaign-spam/config"
import { type CampaignRedis, CampaignReputation } from "@/middlewares/campaign-spam/reputation"

class MemoryRedis implements CampaignRedis {
  private strings = new Map<string, string>()
  private sets = new Map<string, Set<string>>()
  private sortedSets = new Map<string, Map<string, number>>()

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null
  }

  async set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<string | null> {
    if (options?.NX && this.strings.has(key)) return null
    this.strings.set(key, value)
    return "OK"
  }

  async del(key: string): Promise<number> {
    const deletedString = this.strings.delete(key)
    const deletedSet = this.sets.delete(key)
    const deletedSortedSet = this.sortedSets.delete(key)
    return deletedString || deletedSet || deletedSortedSet ? 1 : 0
  }

  async exists(key: string): Promise<number> {
    return this.strings.has(key) || this.sets.has(key) || this.sortedSets.has(key) ? 1 : 0
  }

  async sAdd(key: string, member: string): Promise<number> {
    const values = this.sets.get(key) ?? new Set<string>()
    const before = values.size
    values.add(member)
    this.sets.set(key, values)
    return values.size - before
  }

  async zAdd(key: string, member: { score: number; value: string }): Promise<number> {
    const values = this.sortedSets.get(key) ?? new Map<string, number>()
    const added = values.has(member.value) ? 0 : 1
    values.set(member.value, member.score)
    this.sortedSets.set(key, values)
    return added
  }

  async zCard(key: string): Promise<number> {
    return this.sortedSets.get(key)?.size ?? 0
  }

  async zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number> {
    const values = this.sortedSets.get(key)
    if (!values) return 0

    const lowerBound = Number(min)
    const upperBound = Number(max)
    let removed = 0
    for (const [member, score] of values) {
      if (score < lowerBound || score > upperBound) continue
      values.delete(member)
      removed += 1
    }
    return removed
  }

  async expire(): Promise<boolean> {
    return true
  }
}

const config: CampaignSpamConfig = {
  mode: "enforce",
  joinGate: true,
  quarantineDuration: "10m",
  burstWindowSeconds: 600,
  burstAuthorThreshold: 3,
  burstChatThreshold: 2,
  freshWindowSeconds: 600,
  evidenceRetentionSeconds: 2_592_000,
  pendingMemberSeconds: 86_400,
  profileAuthorThreshold: 3,
  confirmedSignatureHashes: new Set(),
  deniedHandleHashes: new Set(),
  deniedButtonDomainHashes: new Set(),
  deniedViaBotIds: new Set(),
}

describe("campaign reputation", () => {
  let now = 1_000_000
  let reputation: CampaignReputation

  beforeEach(() => {
    now = 1_000_000
    reputation = new CampaignReputation(new MemoryRedis(), config, () => now)
  })

  it("detects an exact campaign burst across three authors and two chats", async () => {
    const signals = extractCampaignSignals({ text: "聘群演每日600+ @cash_helper_47" })

    const first = await reputation.inspectAndRecord(signals, 1, -1001)
    const second = await reputation.inspectAndRecord(signals, 2, -1001)
    const third = await reputation.inspectAndRecord(signals, 3, -1002)

    expect(first.globalBurst).toBe(false)
    expect(second.globalBurst).toBe(false)
    expect(third).toMatchObject({ globalBurst: true, distinctAuthors: 3, distinctChats: 2 })
  })

  it("does not count repeated posts from one author as a network burst", async () => {
    const signals = extractCampaignSignals({ text: "聘群演每日600+ @cash_helper_47" })

    await reputation.inspectAndRecord(signals, 1, -1001)
    await reputation.inspectAndRecord(signals, 1, -1002)
    const snapshot = await reputation.inspectAndRecord(signals, 1, -1003)

    expect(snapshot).toMatchObject({ globalBurst: false, distinctAuthors: 1, distinctChats: 3 })
  })

  it("prunes authors and chats outside the burst window", async () => {
    const signals = extractCampaignSignals({ text: "聘群演每日600+ @cash_helper_47" })

    await reputation.inspectAndRecord(signals, 1, -1009)
    now += 601_000
    await reputation.inspectAndRecord(signals, 2, -1001)
    const secondCurrentAuthor = await reputation.inspectAndRecord(signals, 3, -1001)

    expect(secondCurrentAuthor).toMatchObject({ globalBurst: false, distinctAuthors: 2, distinctChats: 1 })
    const threshold = await reputation.inspectAndRecord(signals, 4, -1002)
    expect(threshold).toMatchObject({ globalBurst: true, distinctAuthors: 3, distinctChats: 2 })
  })

  it("treats only a recently observed join as fresh", async () => {
    const signals = extractCampaignSignals({ text: "小额收点赚 @work_channel_2" })

    expect((await reputation.inspectAndRecord(signals, 7, -1001)).freshUser).toBe(false)
    await reputation.recordJoin(7)
    expect((await reputation.inspectAndRecord(signals, 7, -1001)).freshUser).toBe(true)

    now += 601_000
    expect((await reputation.inspectAndRecord(signals, 7, -1001)).freshUser).toBe(false)

    await reputation.recordJoin(7)
    expect((await reputation.inspectAndRecord(signals, 7, -1001)).freshUser).toBe(true)
  })

  it("learns confirmed signatures and user IDs", async () => {
    const signals = extractCampaignSignals({
      text: "小额收点赚 @work_channel_2",
      buttonUrls: ["https://bad.example/join"],
      viaBotId: 42,
    })
    await reputation.recordConfirmed(signals, { id: 7, firstName: "Student 123", lastName: "Wang" })

    const snapshot = await reputation.inspectAndRecord(signals, 7, -1002)

    expect(snapshot).toMatchObject({
      confirmedSignature: true,
      deniedUser: true,
    })
    expect(signals.mentionedHandleHashes).toEqual([handleFingerprint("work_channel_2")])
    expect(signals.buttonDomainHashes).toEqual([buttonDomainFingerprint("bad.example")])
  })

  it("uses only configured infrastructure as a blocking indicator", async () => {
    const configuredReputation = new CampaignReputation(
      new MemoryRedis(),
      {
        ...config,
        deniedHandleHashes: new Set([handleFingerprint("work_channel_2")]),
        deniedButtonDomainHashes: new Set([buttonDomainFingerprint("bad.example")]),
        deniedViaBotIds: new Set([42]),
      },
      () => now
    )
    const signals = extractCampaignSignals({
      text: "小额收点赚 @work_channel_2",
      buttonUrls: ["https://bad.example/join"],
      viaBotId: 42,
    })

    expect(await configuredReputation.inspectAndRecord(signals, 8, -1002)).toMatchObject({
      knownHandle: true,
      knownButtonDomain: true,
      knownViaBot: true,
    })
  })

  it("requires three confirmed actors before declining a reused profile", async () => {
    const signals = extractCampaignSignals({ text: "聘群演每日600+ @cash_helper_47" })

    for (const id of [1, 2]) {
      await reputation.recordConfirmed(signals, { id, firstName: "Student", lastName: "Wang" })
    }
    expect(await reputation.inspectJoin({ id: 9, firstName: "Student", lastName: "Wang" })).toMatchObject({
      confirmedProfile: false,
      profileAuthors: 2,
    })

    await reputation.recordConfirmed(signals, { id: 3, firstName: "Student", lastName: "Wang" })
    expect(await reputation.inspectJoin({ id: 9, firstName: "Student", lastName: "Wang" })).toMatchObject({
      confirmedProfile: true,
      profileAuthors: 3,
    })
  })

  it("excludes stale actors from a profile after a later confirmation", async () => {
    const shortRetention = new CampaignReputation(
      new MemoryRedis(),
      { ...config, evidenceRetentionSeconds: 10 },
      () => now
    )
    const signals = extractCampaignSignals({ text: "聘群演每日600+ @cash_helper_47" })

    for (const id of [1, 2]) {
      await shortRetention.recordConfirmed(signals, { id, firstName: "Student", lastName: "Wang" })
    }
    now += 11_000
    await shortRetention.recordConfirmed(signals, { id: 3, firstName: "Student", lastName: "Wang" })

    expect(await shortRetention.inspectJoin({ id: 9, firstName: "Student", lastName: "Wang" })).toMatchObject({
      confirmedProfile: false,
      profileAuthors: 1,
    })
  })

  it("deduplicates BanAll work and tracks first-post restrictions", async () => {
    expect(await reputation.claimBanAll(7)).toBe(true)
    expect(await reputation.claimBanAll(7)).toBe(false)
    await reputation.releaseBanAllClaim(7)
    expect(await reputation.claimBanAll(7)).toBe(true)

    await reputation.markPending(-1001, 7)
    expect(await reputation.isPending(-1001, 7)).toBe(true)
    await reputation.clearPending(-1001, 7)
    expect(await reputation.isPending(-1001, 7)).toBe(false)
  })
})
