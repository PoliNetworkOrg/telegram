import { beforeEach, describe, expect, it } from "vitest"
import type { CampaignSpamConfig } from "@/middlewares/campaign-spam/config"
import {
  CAMPAIGN_REPUTATION_KEY_PREFIX,
  CAMPAIGN_REVIEW_RETENTION_SECONDS,
  type CampaignRedis,
  CampaignReputation,
  shouldAutoReleasePendingMember,
} from "@/middlewares/campaign-spam/reputation"
import { CAMPAIGN_TEST_SECRET, campaignTestFingerprint } from "./fixtures/campaign-spam"

const {
  buttonDomain: buttonDomainFingerprint,
  extractSignals: extractCampaignSignals,
  handle: handleFingerprint,
} = campaignTestFingerprint

class MemoryRedis implements CampaignRedis {
  private strings = new Map<string, string>()
  private sets = new Map<string, Set<string>>()
  private sortedSets = new Map<string, Map<string, number>>()
  private expirations = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  private purgeKey(key: string): void {
    const expiresAt = this.expirations.get(key)
    if (expiresAt === undefined || expiresAt > this.now()) return
    this.strings.delete(key)
    this.sets.delete(key)
    this.sortedSets.delete(key)
    this.expirations.delete(key)
  }

  readString(key: string): string | null {
    this.purgeKey(key)
    return this.strings.get(key) ?? null
  }

  readSet(key: string): string[] {
    this.purgeKey(key)
    return [...(this.sets.get(key) ?? [])]
  }

  snapshot(): string {
    for (const key of this.expirations.keys()) this.purgeKey(key)
    return JSON.stringify({
      strings: [...this.strings],
      sets: [...this.sets].map(([key, values]) => [key, [...values]]),
      sortedSets: [...this.sortedSets].map(([key, values]) => [key, [...values]]),
    })
  }

  async get(key: string): Promise<string | null> {
    this.purgeKey(key)
    return this.strings.get(key) ?? null
  }

  async set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<string | null> {
    this.purgeKey(key)
    if (options?.NX && this.strings.has(key)) return null
    this.strings.set(key, value)
    if (options?.EX) this.expirations.set(key, this.now() + options.EX * 1000)
    else this.expirations.delete(key)
    return "OK"
  }

  async del(key: string): Promise<number> {
    const deletedString = this.strings.delete(key)
    const deletedSet = this.sets.delete(key)
    const deletedSortedSet = this.sortedSets.delete(key)
    this.expirations.delete(key)
    return deletedString || deletedSet || deletedSortedSet ? 1 : 0
  }

  async exists(key: string): Promise<number> {
    this.purgeKey(key)
    return this.strings.has(key) || this.sets.has(key) || this.sortedSets.has(key) ? 1 : 0
  }

  async sAdd(key: string, member: string): Promise<number> {
    this.purgeKey(key)
    const values = this.sets.get(key) ?? new Set<string>()
    const before = values.size
    values.add(member)
    this.sets.set(key, values)
    return values.size - before
  }

  async sMembers(key: string): Promise<string[]> {
    this.purgeKey(key)
    return [...(this.sets.get(key) ?? [])]
  }

  async zAdd(key: string, member: { score: number; value: string }): Promise<number> {
    this.purgeKey(key)
    const values = this.sortedSets.get(key) ?? new Map<string, number>()
    const added = values.has(member.value) ? 0 : 1
    values.set(member.value, member.score)
    this.sortedSets.set(key, values)
    return added
  }

  async zCard(key: string): Promise<number> {
    this.purgeKey(key)
    return this.sortedSets.get(key)?.size ?? 0
  }

  async zRem(key: string, member: string): Promise<number> {
    this.purgeKey(key)
    return this.sortedSets.get(key)?.delete(member) ? 1 : 0
  }

  async zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number> {
    this.purgeKey(key)
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

  async expire(key: string, seconds: number): Promise<boolean> {
    this.purgeKey(key)
    if (!this.strings.has(key) && !this.sets.has(key) && !this.sortedSets.has(key)) return false
    this.expirations.set(key, this.now() + seconds * 1000)
    return true
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    if (script.includes("campaign-renew-lease")) {
      const [leaseKey] = options.keys
      const [token, retentionSeconds] = options.arguments
      if (!leaseKey || !token || !retentionSeconds) return 0
      this.purgeKey(leaseKey)
      if (this.strings.get(leaseKey) !== token) return 0
      return (await this.expire(leaseKey, Number(retentionSeconds))) ? 1 : 0
    }

    if (script.includes("campaign-record-confirmed")) {
      const [signature, user, confirmedAt, allowed, profileUsers, actorProfiles, signatureUsers, actorSignatures] =
        options.keys
      const [retention, observedAt, actorHash, profileHash, signatureHash] = options.arguments
      if (
        !signature ||
        !user ||
        !confirmedAt ||
        !allowed ||
        !profileUsers ||
        !actorProfiles ||
        !signatureUsers ||
        !actorSignatures ||
        !retention ||
        !observedAt ||
        !actorHash ||
        !profileHash ||
        !signatureHash
      )
        return 0
      await this.set(signature, "1", { EX: Number(retention) })
      await this.set(user, "1", { EX: Number(retention) })
      await this.set(confirmedAt, observedAt, { EX: Number(retention) })
      await this.del(allowed)
      await this.zAdd(profileUsers, { score: Number(observedAt), value: actorHash })
      await this.sAdd(actorProfiles, profileHash)
      await this.zAdd(signatureUsers, { score: Number(observedAt), value: actorHash })
      await this.sAdd(actorSignatures, signatureHash)
      for (const key of [profileUsers, actorProfiles, signatureUsers, actorSignatures]) {
        await this.expire(key, Number(retention))
      }
      return 1
    }

    if (script.includes("campaign-record-denied-actor")) {
      const [user, confirmedAt, allowed, profileUsers, actorProfiles] = options.keys
      const [retention, observedAt, actorHash, profileHash] = options.arguments
      if (
        !user ||
        !confirmedAt ||
        !allowed ||
        !profileUsers ||
        !actorProfiles ||
        !retention ||
        !observedAt ||
        !actorHash ||
        !profileHash
      )
        return 0
      await this.set(user, "1", { EX: Number(retention) })
      await this.set(confirmedAt, observedAt, { EX: Number(retention) })
      await this.del(allowed)
      await this.zAdd(profileUsers, { score: Number(observedAt), value: actorHash })
      await this.sAdd(actorProfiles, profileHash)
      await this.expire(profileUsers, Number(retention))
      await this.expire(actorProfiles, Number(retention))
      return 1
    }

    if (script.includes("campaign-record-denied-user")) {
      const [user, confirmedAt, allowed] = options.keys
      const [retention, observedAt] = options.arguments
      if (!user || !confirmedAt || !allowed || !retention || !observedAt) return 0
      await this.set(user, "1", { EX: Number(retention) })
      await this.set(confirmedAt, observedAt, { EX: Number(retention) })
      await this.del(allowed)
      return 1
    }

    if (script.includes("campaign-clear-confirmed")) {
      const [user, confirmedAt, allowed, completed, actorSignatures, actorProfiles, idempotency] = options.keys
      const [actorHash, currentProfile, retention, cutoff, prefix] = options.arguments
      if (
        !user ||
        !confirmedAt ||
        !allowed ||
        !completed ||
        !actorSignatures ||
        !actorProfiles ||
        !idempotency ||
        !actorHash ||
        currentProfile === undefined ||
        !retention ||
        !cutoff ||
        !prefix
      )
        return 0
      const signatures = await this.sMembers(actorSignatures)
      const profiles = new Set(await this.sMembers(actorProfiles))
      if (currentProfile) profiles.add(currentProfile)
      await this.del(user)
      await this.del(confirmedAt)
      await this.set(allowed, "1", { EX: Number(retention) })
      await this.del(completed)
      await this.del(idempotency)
      for (const profile of profiles) await this.zRem(`${prefix}:profile-users:${profile}`, actorHash)
      for (const signature of signatures) {
        const usersKey = `${prefix}:signature-users:${signature}`
        await this.zRem(usersKey, actorHash)
        await this.zRemRangeByScore(usersKey, 0, cutoff)
        if ((await this.zCard(usersKey)) === 0) {
          await this.del(`${prefix}:signature:${signature}`)
          await this.del(usersKey)
        }
      }
      await this.del(actorSignatures)
      await this.del(actorProfiles)
      return 1
    }

    const [leaseKey, completedKey] = options.keys
    const [token, retentionSeconds] = options.arguments
    if (!leaseKey || !token) return 0
    this.purgeKey(leaseKey)
    if (this.strings.get(leaseKey) !== token) return 0

    if (completedKey && retentionSeconds) {
      this.strings.set(completedKey, "1")
      this.expirations.set(completedKey, this.now() + Number(retentionSeconds) * 1000)
    }
    await this.del(leaseKey)
    return 1
  }
}

const config: CampaignSpamConfig = {
  fingerprintSecret: CAMPAIGN_TEST_SECRET,
  mode: "enforce",
  joinGate: true,
  quarantineDuration: "10m",
  burstWindowSeconds: 600,
  burstAuthorThreshold: 3,
  burstChatThreshold: 2,
  slowFloodWindowSeconds: 14_400,
  slowFloodAuthorThreshold: 4,
  slowFloodChatThreshold: 2,
  freshWindowSeconds: 86_400,
  evidenceRetentionSeconds: 2_592_000,
  pendingMemberSeconds: 604_800,
  profileAuthorThreshold: 3,
  confirmedSignatureHashes: new Set(),
  deniedUserHashes: new Set(),
  deniedHandleHashes: new Set(),
  deniedButtonDomainHashes: new Set(),
  deniedViaBotHashes: new Set(),
}

describe("campaign reputation", () => {
  let now = 1_000_000
  let client: MemoryRedis
  let reputation: CampaignReputation

  beforeEach(() => {
    now = 1_000_000
    client = new MemoryRedis(() => now)
    reputation = new CampaignReputation(client, config, () => now)
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

  it("detects a slow flood across four authors and two chats", async () => {
    const signals = extractCampaignSignals({ text: "来收米 日入9K" })

    await reputation.inspectAndRecord(signals, 1, -1001)
    now += 601_000
    await reputation.inspectAndRecord(signals, 2, -1002)
    now += 601_000
    await reputation.inspectAndRecord(signals, 3, -1001)
    now += 601_000
    const fourth = await reputation.inspectAndRecord(signals, 4, -1002)

    expect(fourth).toMatchObject({
      globalBurst: false,
      slowFlood: true,
      distinctAuthors: 1,
      distinctChats: 1,
      slowDistinctAuthors: 4,
      slowDistinctChats: 2,
    })
  })

  it("does not turn a slow same-chat repetition into a network-wide ban", async () => {
    const signals = extractCampaignSignals({ text: "来收米 日入9K" })

    for (const id of [1, 2, 3, 4]) {
      await reputation.inspectAndRecord(signals, id, -1001)
      now += 601_000
    }

    expect(await reputation.inspectAndRecord(signals, 5, -1001)).toMatchObject({
      globalBurst: false,
      slowFlood: false,
      slowDistinctAuthors: 5,
      slowDistinctChats: 1,
    })
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

    now += 86_401_000
    expect((await reputation.inspectAndRecord(signals, 7, -1001)).freshUser).toBe(false)

    await reputation.recordJoin(7)
    expect((await reputation.inspectAndRecord(signals, 7, -1001)).freshUser).toBe(true)
  })

  it("keeps pending first-post state after event freshness expires", async () => {
    const signals = extractCampaignSignals({ text: "请联系 @work_channel_2" })
    await reputation.recordJoin(7)
    await reputation.markPending(-1001, 7)

    now += 86_401_000

    expect((await reputation.inspectAndRecord(signals, 7, -1001)).freshUser).toBe(false)
    expect(await reputation.pendingState(-1001, 7)).toBe("first_post")

    now += 518_400_000
    expect(await reputation.pendingState(-1001, 7)).toBeNull()
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

  it("does not leave orphan blocking state when an atomic confirmation fails", async () => {
    const signals = extractCampaignSignals({ text: "来收米 日入9K" })
    const evaluate = client.eval.bind(client)
    client.eval = async (script, options) => {
      if (script.includes("campaign-record-confirmed")) throw new Error("simulated Redis failure")
      return evaluate(script, options)
    }

    await expect(
      reputation.recordConfirmed(signals, { id: 7, firstName: "Student", lastName: "Wang" })
    ).rejects.toThrow("simulated Redis failure")
    expect(await reputation.inspectAndRecord(signals, 8, -1001)).toMatchObject({
      confirmedSignature: false,
      deniedUser: false,
    })
  })

  it("uses only configured infrastructure as a blocking indicator", async () => {
    const configuredReputation = new CampaignReputation(
      new MemoryRedis(),
      {
        ...config,
        deniedHandleHashes: new Set([handleFingerprint("work_channel_2")]),
        deniedButtonDomainHashes: new Set([buttonDomainFingerprint("bad.example")]),
        deniedViaBotHashes: new Set([campaignTestFingerprint.indicatorHash("via_bot", "42")]),
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

  it("uses configured user IDs before the guard has learned them", async () => {
    const configuredReputation = new CampaignReputation(
      new MemoryRedis(),
      {
        ...config,
        deniedUserHashes: new Set([campaignTestFingerprint.indicatorHash("user_id", "8")]),
      },
      () => now
    )
    const signals = extractCampaignSignals({ text: "A plain message" })

    expect(await configuredReputation.inspectAndRecord(signals, 8, -1002)).toMatchObject({ deniedUser: true })
    expect(await configuredReputation.inspectJoin({ id: 8, firstName: "Any" })).toMatchObject({ deniedUser: true })

    await configuredReputation.clearConfirmed({ id: 8 })
    expect(await configuredReputation.inspectJoin({ id: 8, firstName: "Any" })).toMatchObject({ deniedUser: false })
  })

  it("reviews a multi-factor campaign profile without treating it as a confirmed decline", async () => {
    expect(await reputation.inspectJoin({ id: 8_622_804_182, firstName: "最低8Oo+" })).toMatchObject({
      deniedUser: false,
      confirmedProfile: false,
      profileAuthors: 0,
      riskyProfile: true,
    })
    expect(
      await reputation.inspectJoin({ id: 8_622_804_183, firstName: "最低8Oo+", username: "known_student" })
    ).toMatchObject({ riskyProfile: false })
  })

  it("retains complete hashed evidence and preserves first-seen time", async () => {
    const signals = extractCampaignSignals({
      text: "小额收点赚 @work_channel_2",
      entityTypes: ["mention", "text_mention"],
      mentionedUserIds: [99],
      buttonUrls: ["https://bad.example/join?id=1"],
      hasInlineKeyboard: true,
      viaBotId: 42,
      viaBotUsername: "campaign_helper_bot",
    })

    await reputation.inspectAndRecord(signals, 7, -1001)
    const firstSeenKey = `${CAMPAIGN_REPUTATION_KEY_PREFIX}:first-seen:${signals.signatureHash}`
    const lastSeenKey = `${CAMPAIGN_REPUTATION_KEY_PREFIX}:last-seen:${signals.signatureHash}`
    expect(client.readString(firstSeenKey)).toBe("1000000")

    now += 1_000
    await reputation.inspectAndRecord(signals, 8, -1002)
    expect(client.readString(firstSeenKey)).toBe("1000000")
    expect(client.readString(lastSeenKey)).toBe("1001000")
    expect(
      client.readSet(`${CAMPAIGN_REPUTATION_KEY_PREFIX}:evidence-mentionedUsers:${signals.signatureHash}`)
    ).toEqual(signals.mentionedUserIdHashes)
    expect(client.readSet(`${CAMPAIGN_REPUTATION_KEY_PREFIX}:evidence-buttonUrls:${signals.signatureHash}`)).toEqual(
      signals.buttonUrlHashes
    )
    expect(
      client.readSet(`${CAMPAIGN_REPUTATION_KEY_PREFIX}:evidence-viaBotUsernames:${signals.signatureHash}`)
    ).toEqual([signals.viaBotUsernameHash])
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

  it("removes reversed users, profile evidence, and automatic signatures", async () => {
    const signals = extractCampaignSignals({ text: "聘群演每日600+ @cash_helper_47" })
    const actor = { id: 7, firstName: "Student", lastName: "Wang" }
    await reputation.recordConfirmed(signals, actor)

    await reputation.clearConfirmed(actor)

    expect(await reputation.inspectJoin({ id: 7, firstName: "Student", lastName: "Wang" })).toMatchObject({
      deniedUser: false,
      profileAuthors: 0,
    })
    expect(await reputation.inspectAndRecord(signals, 8, -1002)).toMatchObject({ confirmedSignature: false })
  })

  it("removes the profile that was learned before a display-name change", async () => {
    const actor = { id: 7, firstName: "Student", lastName: "Wang" }
    await reputation.recordDeniedActor(actor)

    await reputation.clearConfirmed({ id: 7, firstName: "Student", lastName: "Li" })

    expect(await reputation.inspectJoin({ id: 9, firstName: "Student", lastName: "Wang" })).toMatchObject({
      confirmedProfile: false,
      profileAuthors: 0,
    })
  })

  it("keeps a signature while another active confirmation remains", async () => {
    const signals = extractCampaignSignals({ text: "聘群演每日600+ @cash_helper_47" })
    const first = { id: 7, firstName: "Student", lastName: "Wang" }
    const second = { id: 8, firstName: "Student", lastName: "Li" }
    await reputation.recordConfirmed(signals, first)
    await reputation.recordConfirmed(signals, second)

    await reputation.clearConfirmed(first)
    expect(await reputation.inspectAndRecord(signals, 9, -1002)).toMatchObject({ confirmedSignature: true })

    await reputation.clearConfirmed(second)
    expect(await reputation.inspectAndRecord(signals, 9, -1002)).toMatchObject({ confirmedSignature: false })
  })

  it("never persists raw Telegram user or chat IDs", async () => {
    const actorId = 987_654_321
    const chatId = -100_987_654_321
    const reviewId = "sensitive-review-123456789"
    const signals = extractCampaignSignals({
      text: "聘群演每日600+ @cash_helper_47 +14849105421",
      source: "contact",
      contactPhoneNumber: "+14849105421",
      viaBotId: 876_543_219,
    })

    await reputation.recordJoin(actorId)
    await reputation.inspectAndRecord(signals, actorId, chatId)
    await reputation.recordConfirmed(signals, { id: actorId, firstName: "Student", lastName: "Wang" })
    await reputation.markPending(chatId, actorId)
    await reputation.runActorOperation({ id: actorId, firstName: "Student", lastName: "Wang" }, (mutations) =>
      mutations.markCurrentReview(chatId, reviewId)
    )

    const persisted = client.snapshot()
    expect(persisted).toContain(CAMPAIGN_REPUTATION_KEY_PREFIX)
    expect(persisted).not.toContain(String(actorId))
    expect(persisted).not.toContain(String(chatId))
    expect(persisted).not.toContain("876543219")
    expect(persisted).not.toContain("+14849105421")
    expect(persisted).not.toContain(reviewId)
  })

  it("deduplicates completed BanAll work while failed leases remain retryable", async () => {
    const first = await reputation.claimBanAllOperation(7)
    expect(first.status).toBe("claimed")
    expect((await reputation.claimBanAllOperation(7)).status).toBe("busy")
    if (first.status !== "claimed") throw new Error("expected BanAll claim")
    await reputation.releaseBanAllOperation(7, "not-the-owner")
    expect((await reputation.claimBanAllOperation(7)).status).toBe("busy")
    await reputation.releaseBanAllOperation(7, first.token)

    const retry = await reputation.claimBanAllOperation(7)
    expect(retry.status).toBe("claimed")
    if (retry.status !== "claimed") throw new Error("expected BanAll retry claim")
    expect(retry.idempotencyKey).toBe(first.idempotencyKey)
    expect(await reputation.completeBanAllOperation(7, "not-the-owner")).toBe(false)
    expect(await reputation.completeBanAllOperation(7, retry.token)).toBe(true)
    expect((await reputation.claimBanAllOperation(7)).status).toBe("completed")

    await reputation.clearConfirmed({ id: 7 })
    const afterRelease = await reputation.claimBanAllOperation(7)
    expect(afterRelease.status).toBe("claimed")
    if (afterRelease.status !== "claimed") throw new Error("expected post-release BanAll claim")
    expect(afterRelease.idempotencyKey).not.toBe(retry.idempotencyKey)
    await reputation.releaseBanAllOperation(7, afterRelease.token)
  })

  it("does not let an expired lease owner complete or release a replacement operation", async () => {
    const expired = await reputation.claimBanAllOperation(7)
    if (expired.status !== "claimed") throw new Error("expected initial BanAll claim")
    now += 301_000

    const replacement = await reputation.claimBanAllOperation(7)
    if (replacement.status !== "claimed") throw new Error("expected replacement BanAll claim")
    expect(await reputation.completeBanAllOperation(7, expired.token)).toBe(false)
    await reputation.releaseBanAllOperation(7, expired.token)
    expect((await reputation.claimBanAllOperation(7)).status).toBe("busy")
    expect(await reputation.completeBanAllOperation(7, replacement.token)).toBe(true)
  })

  it("releases a claimed lease when the completed-state recheck fails", async () => {
    const exists = client.exists.bind(client)
    let completedChecks = 0
    client.exists = async (key) => {
      if (key.includes("ban-all-completed") && ++completedChecks === 2) {
        throw new Error("simulated completed-state failure")
      }
      return exists(key)
    }

    await expect(reputation.claimBanAllOperation(7)).rejects.toThrow("simulated completed-state failure")
    client.exists = exists

    const retry = await reputation.claimBanAllOperation(7)
    expect(retry.status).toBe("claimed")
    if (retry.status === "claimed") await reputation.releaseBanAllOperation(7, retry.token)
  })

  it("tracks first-post restrictions", async () => {
    await reputation.markPending(-1001, 7)
    expect(await reputation.pendingState(-1001, 7)).toBe("first_post")
    await reputation.markPending(-1001, 7, "review")
    expect(await reputation.pendingState(-1001, 7)).toBe("review")
    await reputation.clearPending(-1001, 7)
    expect(await reputation.pendingState(-1001, 7)).toBeNull()
  })

  it("keeps reviewed profiles restricted after a benign first post", () => {
    expect(shouldAutoReleasePendingMember("review", true)).toBe(false)
    expect(shouldAutoReleasePendingMember("first_post", true)).toBe(true)
    expect(shouldAutoReleasePendingMember("first_post", false)).toBe(false)
  })

  it("keeps a delivered manual-review hold for its bounded operator lifecycle", async () => {
    await reputation.markPending(-1001, 7, "review")
    now += (config.pendingMemberSeconds + 1) * 1000

    expect(await reputation.pendingState(-1001, 7)).toBe("review")
    now += (CAMPAIGN_REVIEW_RETENTION_SECONDS - config.pendingMemberSeconds) * 1000
    expect(await reputation.pendingState(-1001, 7)).toBeNull()
  })

  it("makes only completed review decisions single-use", async () => {
    const first = await reputation.claimReviewOperation("review-1234567890")
    expect(first.status).toBe("claimed")
    expect((await reputation.claimReviewOperation("review-1234567890")).status).toBe("busy")
    if (first.status !== "claimed") throw new Error("expected review claim")
    await reputation.releaseReviewOperation("review-1234567890", first.token)

    const retry = await reputation.claimReviewOperation("review-1234567890")
    expect(retry.status).toBe("claimed")
    if (retry.status !== "claimed") throw new Error("expected review retry claim")
    expect(await reputation.completeReviewOperation("review-1234567890", retry.token)).toBe(true)
    expect((await reputation.claimReviewOperation("review-1234567890")).status).toBe("completed")
  })

  it("retains completed review decisions for the bounded callback lifecycle", async () => {
    const shortRetention = new CampaignReputation(client, { ...config, evidenceRetentionSeconds: 3_600 }, () => now)
    const claim = await shortRetention.claimReviewOperation("review-short-retention")
    if (claim.status !== "claimed") throw new Error("expected review claim")
    expect(await shortRetention.completeReviewOperation("review-short-retention", claim.token)).toBe(true)

    now += 3_601_000
    expect((await shortRetention.claimReviewOperation("review-short-retention")).status).toBe("completed")
    now += CAMPAIGN_REVIEW_RETENTION_SECONDS * 1000
    const afterRetention = await shortRetention.claimReviewOperation("review-short-retention")
    expect(afterRetention.status).toBe("claimed")
    if (afterRetention.status === "claimed") {
      await shortRetention.releaseReviewOperation("review-short-retention", afterRetention.token)
    }
  })

  it("blocks stale releases and preserves state when permission restoration fails", async () => {
    const actor = { id: 7, firstName: "Student", lastName: "Wang" }
    await reputation.recordDeniedUser(7)
    let restoreCalls = 0

    expect(
      await reputation.releaseConfirmedIfCurrent(actor, now, undefined, async () => {
        restoreCalls += 1
        return true
      })
    ).toBe("stale")
    expect(restoreCalls).toBe(0)

    expect(await reputation.releaseConfirmedIfCurrent(actor, now + 1, undefined, async () => false)).toBe(
      "not_released"
    )
    expect((await reputation.inspectJoin(actor)).deniedUser).toBe(true)

    expect(await reputation.releaseConfirmedIfCurrent(actor, now + 1, undefined, async () => true)).toBe("released")
    expect((await reputation.inspectJoin(actor)).deniedUser).toBe(false)
  })

  it("serializes confirmation workflows against moderator release", async () => {
    const actor = { id: 7, firstName: "Student", lastName: "Wang" }
    let signalStarted: () => void = () => {}
    let resumeOperation: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const pause = new Promise<void>((resolve) => {
      resumeOperation = resolve
    })
    const running = reputation.runActorOperation(actor, async (mutations) => {
      await mutations.recordDeniedActor()
      signalStarted()
      await pause
    })
    await started

    await expect(reputation.releaseConfirmedIfCurrent(actor, now + 1, undefined, async () => true)).rejects.toThrow(
      "already in progress"
    )
    resumeOperation()
    await running
    expect((await reputation.inspectJoin(actor)).deniedUser).toBe(true)
  })

  it("does not let an older review release a newer hold in the same chat", async () => {
    const actor = { id: 7, firstName: "Student", lastName: "Wang" }
    const firstReview = { chatId: -1001, reviewId: "first-review-123456789" }
    const secondReview = { chatId: -1001, reviewId: "second-review-12345678" }
    await reputation.runActorOperation(actor, (mutations) =>
      mutations.markCurrentReview(firstReview.chatId, firstReview.reviewId)
    )
    await reputation.runActorOperation(actor, (mutations) =>
      mutations.markCurrentReview(secondReview.chatId, secondReview.reviewId)
    )
    let restoreCalls = 0

    expect(
      await reputation.releaseConfirmedIfCurrent(actor, now + 1, firstReview, async () => {
        restoreCalls += 1
        return true
      })
    ).toBe("stale")
    expect(restoreCalls).toBe(0)
    expect(
      await reputation.releaseConfirmedIfCurrent(actor, now + 1, secondReview, async () => {
        restoreCalls += 1
        return true
      })
    ).toBe("released")
    expect(restoreCalls).toBe(1)
  })
})
