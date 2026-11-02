import { randomBytes } from "node:crypto"
import type { User } from "grammy/types"
import type { CampaignMessageSignals, CampaignReputationSnapshot } from "./classifier"
import {
  campaignIndicatorHash,
  EMPTY_CAMPAIGN_REPUTATION,
  isCampaignCandidate,
  isRiskyCampaignProfile,
  profileFingerprint,
} from "./classifier"
import type { CampaignSpamConfig } from "./config"

export const CAMPAIGN_REPUTATION_KEY_PREFIX = "moderation:campaign:v2"
export const CAMPAIGN_REVIEW_RETENTION_SECONDS = 365 * 86_400
const BAN_ALL_IDEMPOTENCY_RETENTION_SECONDS = 30 * 86_400
const OPERATION_LEASE_SECONDS = 300
const RELEASE_LEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`
const RENEW_LEASE_SCRIPT = `
-- campaign-renew-lease
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
end
return 0
`
const COMPLETE_OPERATION_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  if tonumber(ARGV[2]) > 0 then
    redis.call("set", KEYS[2], "1", "EX", ARGV[2])
  else
    redis.call("set", KEYS[2], "1")
  end
  redis.call("del", KEYS[1])
  return 1
end
return 0
`
const RECORD_CONFIRMED_SCRIPT = `
-- campaign-record-confirmed
local retention = ARGV[1]
local observedAt = ARGV[2]
local actorHash = ARGV[3]
local profileHash = ARGV[4]
local signatureHash = ARGV[5]
redis.call("set", KEYS[1], "1", "EX", retention)
redis.call("set", KEYS[2], "1", "EX", retention)
redis.call("set", KEYS[3], observedAt, "EX", retention)
redis.call("del", KEYS[4])
redis.call("zadd", KEYS[5], observedAt, actorHash)
redis.call("sadd", KEYS[6], profileHash)
redis.call("zadd", KEYS[7], observedAt, actorHash)
redis.call("sadd", KEYS[8], signatureHash)
redis.call("expire", KEYS[5], retention)
redis.call("expire", KEYS[6], retention)
redis.call("expire", KEYS[7], retention)
redis.call("expire", KEYS[8], retention)
return 1
`
const RECORD_DENIED_ACTOR_SCRIPT = `
-- campaign-record-denied-actor
local retention = ARGV[1]
local observedAt = ARGV[2]
local actorHash = ARGV[3]
local profileHash = ARGV[4]
redis.call("set", KEYS[1], "1", "EX", retention)
redis.call("set", KEYS[2], observedAt, "EX", retention)
redis.call("del", KEYS[3])
redis.call("zadd", KEYS[4], observedAt, actorHash)
redis.call("sadd", KEYS[5], profileHash)
redis.call("expire", KEYS[4], retention)
redis.call("expire", KEYS[5], retention)
return 1
`
const RECORD_DENIED_USER_SCRIPT = `
-- campaign-record-denied-user
redis.call("set", KEYS[1], "1", "EX", ARGV[1])
redis.call("set", KEYS[2], ARGV[2], "EX", ARGV[1])
redis.call("del", KEYS[3])
return 1
`
const CLEAR_CONFIRMED_SCRIPT = `
-- campaign-clear-confirmed
local actorHash = ARGV[1]
local profileHash = ARGV[2]
local retention = ARGV[3]
local cutoff = ARGV[4]
local prefix = ARGV[5]
local signatures = redis.call("smembers", KEYS[5])
local profiles = redis.call("smembers", KEYS[6])
redis.call("del", KEYS[1])
redis.call("del", KEYS[2])
redis.call("set", KEYS[3], "1", "EX", retention)
redis.call("del", KEYS[4])
redis.call("del", KEYS[7])
for _, storedProfile in ipairs(profiles) do
  redis.call("zrem", prefix .. ":profile-users:" .. storedProfile, actorHash)
end
if profileHash ~= "" then
  redis.call("zrem", prefix .. ":profile-users:" .. profileHash, actorHash)
end
for _, signatureHash in ipairs(signatures) do
  local usersKey = prefix .. ":signature-users:" .. signatureHash
  redis.call("zrem", usersKey, actorHash)
  redis.call("zremrangebyscore", usersKey, 0, cutoff)
  if redis.call("zcard", usersKey) == 0 then
    redis.call("del", prefix .. ":signature:" .. signatureHash)
    redis.call("del", usersKey)
  end
end
redis.call("del", KEYS[5])
redis.call("del", KEYS[6])
return 1
`

export type CampaignRedis = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<string | null>
  del(key: string): Promise<number>
  exists(key: string): Promise<number>
  sAdd(key: string, member: string): Promise<number>
  zAdd(key: string, member: { score: number; value: string }): Promise<number>
  zCard(key: string): Promise<number>
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number>
  expire(key: string, seconds: number): Promise<boolean>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export type CampaignOperationClaim = { status: "busy" } | { status: "completed" } | { status: "claimed"; token: string }
export type CampaignBanAllClaim =
  | { status: "busy" }
  | { status: "completed" }
  | { status: "claimed"; token: string; idempotencyKey: string }

export type CampaignReleaseResult = "released" | "stale" | "not_released"
export type CampaignPendingState = "first_post" | "review"

export class CampaignActorOperationBusyError extends Error {
  constructor() {
    super("Campaign actor mutation is already in progress")
    this.name = "CampaignActorOperationBusyError"
  }
}

/** Allows automatic release only for an ordinary admission's first new message. */
export function shouldAutoReleasePendingMember(state: CampaignPendingState | null, isNewMessage: boolean): boolean {
  return state === "first_post" && isNewMessage
}

export type CampaignActor = {
  id: number
  firstName: string
  lastName?: string
  username?: string
}

/** Copies the Telegram identity fields retained by campaign reputation. */
export function campaignActorFromUser(user: User): CampaignActor {
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
  }
}

export type CampaignConfirmationSignals = Pick<CampaignMessageSignals, "signatureHash">

export type CampaignActorMutations = {
  assertOwned(): Promise<void>
  clearCurrentReview(chatId: number, reviewId: string): Promise<void>
  isCurrentReview(chatId: number, reviewId: string): Promise<boolean>
  markCurrentReview(chatId: number, reviewId: string): Promise<void>
  recordConfirmed(signals: CampaignConfirmationSignals): Promise<void>
  recordDeniedActor(): Promise<void>
}

export type CampaignReviewReference = {
  chatId: number
  reviewId: string
}

export type CampaignJoinReputation = {
  deniedUser: boolean
  confirmedProfile: boolean
  profileAuthors: number
  riskyProfile: boolean
}

/** Stores short-lived campaign evidence and learned moderation decisions in Redis. */
export class CampaignReputation {
  private readonly leaseHeartbeats = new Map<
    string,
    { lost: boolean; renewing: boolean; timer: ReturnType<typeof setInterval> }
  >()

  constructor(
    private readonly client: CampaignRedis,
    private readonly config: CampaignSpamConfig,
    private readonly now: () => number = Date.now
  ) {}

  /** Builds a versioned Redis key from an already protected identifier. */
  private key(kind: string, value: string): string {
    return `${CAMPAIGN_REPUTATION_KEY_PREFIX}:${kind}:${value}`
  }

  /** Protects a Telegram user ID before it enters a Redis key or collection. */
  private userFingerprint(actorId: number): string {
    return campaignIndicatorHash("user_id", String(actorId), this.config.fingerprintSecret)
  }

  /** Protects a Telegram chat ID before it enters a Redis collection. */
  private chatFingerprint(chatId: number): string {
    return campaignIndicatorHash("chat_id", String(chatId), this.config.fingerprintSecret)
  }

  /** Builds an actor-scoped key without exposing the Telegram user ID. */
  private userKey(kind: string, actorId: number): string {
    return this.key(kind, this.userFingerprint(actorId))
  }

  /** Builds a pending-member key from protected chat and user fingerprints. */
  private pendingKey(chatId: number, actorId: number): string {
    return this.key("pending", `${this.chatFingerprint(chatId)}:${this.userFingerprint(actorId)}`)
  }

  /** Builds the per-chat pointer used to reject superseded review callbacks. */
  private currentReviewKey(chatId: number, actorId: number): string {
    return this.key("current-review", `${this.chatFingerprint(chatId)}:${this.userFingerprint(actorId)}`)
  }

  /** Protects a random review ID before storing it as current-review state. */
  private reviewFingerprint(reviewId: string): string {
    return campaignIndicatorHash("review_id", reviewId, this.config.fingerprintSecret)
  }

  /** Acquires a short operation lease with a random ownership token. */
  private async claimLease(key: string): Promise<string | null> {
    const token = randomBytes(16).toString("base64url")
    const result = await this.client.set(key, token, { EX: OPERATION_LEASE_SECONDS, NX: true })
    if (result !== "OK") return null
    this.startLeaseHeartbeat(key, token)
    return token
  }

  private startLeaseHeartbeat(key: string, token: string): void {
    const state = {
      lost: false,
      renewing: false,
      timer: setInterval(
        () => {
          if (state.renewing || state.lost) return
          state.renewing = true
          void this.renewLease(key, token)
            .then((owned) => {
              if (!owned) {
                state.lost = true
                this.stopLeaseHeartbeat(token)
              }
            })
            .catch(() => {
              state.lost = true
              this.stopLeaseHeartbeat(token)
            })
            .finally(() => {
              state.renewing = false
            })
        },
        (OPERATION_LEASE_SECONDS * 1000) / 3
      ),
    }
    state.timer.unref()
    this.leaseHeartbeats.set(token, state)
  }

  private stopLeaseHeartbeat(token: string): void {
    const state = this.leaseHeartbeats.get(token)
    if (!state) return
    clearInterval(state.timer)
    this.leaseHeartbeats.delete(token)
  }

  private async renewLease(key: string, token: string): Promise<boolean> {
    const result = await this.client.eval(RENEW_LEASE_SCRIPT, {
      keys: [key],
      arguments: [token, String(OPERATION_LEASE_SECONDS)],
    })
    return Number(result) === 1
  }

  private async assertLeaseOwned(key: string, token: string): Promise<void> {
    const state = this.leaseHeartbeats.get(token)
    if (state?.lost) {
      this.stopLeaseHeartbeat(token)
      throw new Error("Campaign operation lease was lost")
    }

    let owned: boolean
    try {
      owned = await this.renewLease(key, token)
    } catch (error) {
      if (state) state.lost = true
      this.stopLeaseHeartbeat(token)
      throw error
    }
    if (owned) return

    if (state) state.lost = true
    this.stopLeaseHeartbeat(token)
    throw new Error("Campaign operation lease was lost")
  }

  /** Releases only the lease owned by this operation, even after TTL/reacquisition races. */
  private async releaseLease(key: string, token: string): Promise<void> {
    this.stopLeaseHeartbeat(token)
    await this.client.eval(RELEASE_LEASE_SCRIPT, { keys: [key], arguments: [token] })
  }

  private async withActorMutation<T>(
    actorId: number,
    operation: (assertOwned: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const key = this.userKey("actor-operation", actorId)
    const token = await this.claimLease(key)
    if (!token) throw new CampaignActorOperationBusyError()
    try {
      const assertOwned = () => this.assertLeaseOwned(key, token)
      await assertOwned()
      return await operation(assertOwned)
    } finally {
      await this.releaseLease(key, token)
    }
  }

  private async claimOperation(leaseKey: string, completedKey: string): Promise<CampaignOperationClaim> {
    if ((await this.client.exists(completedKey)) > 0) return { status: "completed" }
    const token = await this.claimLease(leaseKey)
    if (!token) return { status: "busy" }
    try {
      if ((await this.client.exists(completedKey)) === 0) return { status: "claimed", token }
      await this.releaseLease(leaseKey, token)
      return { status: "completed" }
    } catch (error) {
      await this.releaseLease(leaseKey, token).catch(() => {})
      throw error
    }
  }

  private async completeOperation(
    leaseKey: string,
    completedKey: string,
    token: string,
    retentionSeconds = this.config.evidenceRetentionSeconds
  ): Promise<boolean> {
    try {
      const result = await this.client.eval(COMPLETE_OPERATION_SCRIPT, {
        keys: [leaseKey, completedKey],
        arguments: [token, String(retentionSeconds)],
      })
      return Number(result) === 1
    } finally {
      this.stopLeaseHeartbeat(token)
    }
  }

  /** Reads operator-managed indicators without touching Redis. */
  private configuredSnapshot(signals: CampaignMessageSignals, actorId: number): CampaignReputationSnapshot {
    const actorHash = this.userFingerprint(actorId)
    return {
      ...EMPTY_CAMPAIGN_REPUTATION,
      confirmedSignature: this.config.confirmedSignatureHashes.has(signals.signatureHash),
      deniedUser: this.config.deniedUserHashes.has(actorHash),
      knownHandle: signals.mentionedHandleHashes.some((hash) => this.config.deniedHandleHashes.has(hash)),
      knownButtonDomain: signals.buttonDomainHashes.some((hash) => this.config.deniedButtonDomainHashes.has(hash)),
      knownViaBot: signals.viaBotIdHash !== undefined && this.config.deniedViaBotHashes.has(signals.viaBotIdHash),
    }
  }

  /** Records distinct protected actors and chats inside one configured campaign window. */
  private async recordWindow(
    kind: "burst" | "slow-flood",
    signals: CampaignMessageSignals,
    actorId: number,
    chatId: number,
    windowSeconds: number
  ) {
    const authorsKey = this.key(`${kind}-authors`, signals.signatureHash)
    const chatsKey = this.key(`${kind}-chats`, signals.signatureHash)
    const observedAt = this.now()
    const cutoff = observedAt - windowSeconds * 1000

    await Promise.all([
      this.client.zAdd(authorsKey, { score: observedAt, value: this.userFingerprint(actorId) }),
      this.client.zAdd(chatsKey, { score: observedAt, value: this.chatFingerprint(chatId) }),
      this.client.zRemRangeByScore(authorsKey, 0, cutoff),
      this.client.zRemRangeByScore(chatsKey, 0, cutoff),
      this.client.expire(authorsKey, windowSeconds),
      this.client.expire(chatsKey, windowSeconds),
    ])

    const [distinctAuthors, distinctChats] = await Promise.all([
      this.client.zCard(authorsKey),
      this.client.zCard(chatsKey),
    ])
    return { distinctAuthors, distinctChats }
  }

  /** Retains only protected evidence values and coarse message metadata. */
  private async recordEvidence(signals: CampaignMessageSignals): Promise<void> {
    const signatureHash = signals.signatureHash
    const observedAt = String(this.now())
    const evidence = {
      handles: signals.mentionedHandleHashes,
      mentionedUsers: signals.mentionedUserIdHashes,
      buttonUrls: signals.buttonUrlHashes,
      buttonDomains: signals.buttonDomainHashes,
      contactPhones: signals.contactPhoneHash === undefined ? [] : [signals.contactPhoneHash],
      viaBotIds: signals.viaBotIdHash === undefined ? [] : [signals.viaBotIdHash],
      viaBotUsernames: signals.viaBotUsernameHash ? [signals.viaBotUsernameHash] : [],
      entities: signals.entityTypes,
      flags: [
        ...(signals.hasInlineKeyboard ? ["inline_keyboard"] : []),
        ...(signals.hasContactCard ? ["contact_card"] : []),
        ...(signals.hasCampaignLure ? ["campaign_lure"] : []),
        ...(signals.hasLink ? ["external_link"] : []),
      ],
    }
    const writes: Promise<unknown>[] = [
      this.client.set(this.key("first-seen", signatureHash), observedAt, {
        EX: this.config.evidenceRetentionSeconds,
        NX: true,
      }),
      this.client.set(this.key("last-seen", signatureHash), observedAt, {
        EX: this.config.evidenceRetentionSeconds,
      }),
    ]

    for (const [kind, values] of Object.entries(evidence)) {
      const key = this.key(`evidence-${kind}`, signatureHash)
      for (const value of values) writes.push(this.client.sAdd(key, value))
      writes.push(this.client.expire(key, this.config.evidenceRetentionSeconds))
    }
    await Promise.all(writes)
  }

  /** Reads current reputation and records eligible cross-network evidence. */
  async inspectAndRecord(
    signals: CampaignMessageSignals,
    actorId: number,
    chatId: number
  ): Promise<CampaignReputationSnapshot> {
    const configured = this.configuredSnapshot(signals, actorId)
    const isBurstCandidate = isCampaignCandidate(signals)

    const [confirmedSignature, deniedUser, allowedUser, joinedAt] = await Promise.all([
      this.client.exists(this.key("signature", signals.signatureHash)),
      this.client.exists(this.userKey("user", actorId)),
      this.client.exists(this.userKey("user-allow", actorId)),
      this.client.get(this.userKey("joined-at", actorId)),
    ])

    let distinctAuthors = 0
    let distinctChats = 0
    let slowDistinctAuthors = 0
    let slowDistinctChats = 0
    if (isBurstCandidate) {
      const [burst, slowFlood] = await Promise.all([
        this.recordWindow("burst", signals, actorId, chatId, this.config.burstWindowSeconds),
        this.recordWindow("slow-flood", signals, actorId, chatId, this.config.slowFloodWindowSeconds),
      ])
      distinctAuthors = burst.distinctAuthors
      distinctChats = burst.distinctChats
      slowDistinctAuthors = slowFlood.distinctAuthors
      slowDistinctChats = slowFlood.distinctChats
    }
    const hasKnownCampaignSignal =
      isBurstCandidate ||
      configured.confirmedSignature ||
      configured.deniedUser ||
      configured.knownHandle ||
      configured.knownButtonDomain ||
      configured.knownViaBot ||
      confirmedSignature > 0 ||
      deniedUser > 0
    if (hasKnownCampaignSignal) await this.recordEvidence(signals)

    const joinedAtMs = joinedAt === null ? Number.NaN : Number(joinedAt)
    const freshUser = Number.isFinite(joinedAtMs) && this.now() - joinedAtMs <= this.config.freshWindowSeconds * 1000

    return {
      confirmedSignature: configured.confirmedSignature || confirmedSignature > 0,
      deniedUser: (configured.deniedUser && allowedUser === 0) || deniedUser > 0,
      freshUser,
      globalBurst:
        distinctAuthors >= this.config.burstAuthorThreshold && distinctChats >= this.config.burstChatThreshold,
      slowFlood:
        slowDistinctAuthors >= this.config.slowFloodAuthorThreshold &&
        slowDistinctChats >= this.config.slowFloodChatThreshold,
      knownButtonDomain: configured.knownButtonDomain,
      knownHandle: configured.knownHandle,
      knownViaBot: configured.knownViaBot,
      distinctAuthors,
      distinctChats,
      slowDistinctAuthors,
      slowDistinctChats,
    }
  }

  /** Returns only static indicators when Redis is unavailable. */
  configuredOnly(signals: CampaignMessageSignals, actorId: number): CampaignReputationSnapshot {
    return this.configuredSnapshot(signals, actorId)
  }

  /** Marks an account as fresh for the configured first-post window. */
  async recordJoin(actorId: number): Promise<void> {
    await this.client.set(this.userKey("joined-at", actorId), String(this.now()), {
      EX: this.config.freshWindowSeconds,
    })
  }

  /** Learns a confirmed account, profile, and message signature. */
  async recordConfirmed(signals: CampaignConfirmationSignals, actor: CampaignActor): Promise<void> {
    await this.withActorMutation(actor.id, async (assertOwned) => {
      await assertOwned()
      await this.recordConfirmedUnlocked(signals, actor)
    })
  }

  /** Runs one actor workflow with mutation helpers that cannot deadlock on the same lease. */
  async runActorOperation<T>(
    actor: CampaignActor,
    operation: (mutations: CampaignActorMutations) => Promise<T>
  ): Promise<T> {
    return this.withActorMutation(actor.id, (assertOwned) =>
      operation({
        assertOwned,
        clearCurrentReview: async (chatId, reviewId) => {
          await assertOwned()
          await this.clearCurrentReviewUnlocked(chatId, actor.id, reviewId)
        },
        isCurrentReview: async (chatId, reviewId) => {
          await assertOwned()
          return this.isCurrentReviewUnlocked(chatId, actor.id, reviewId)
        },
        markCurrentReview: async (chatId, reviewId) => {
          await assertOwned()
          await this.markCurrentReviewUnlocked(chatId, actor.id, reviewId)
        },
        recordConfirmed: async (signals) => {
          await assertOwned()
          await this.recordConfirmedUnlocked(signals, actor)
        },
        recordDeniedActor: async () => {
          await assertOwned()
          await this.recordDeniedActorUnlocked(actor)
        },
      })
    )
  }

  private async recordConfirmedUnlocked(signals: CampaignConfirmationSignals, actor: CampaignActor): Promise<void> {
    const observedAt = this.now()
    const profile = profileFingerprint(actor.firstName, actor.lastName, this.config.fingerprintSecret)
    const actorHash = this.userFingerprint(actor.id)
    await this.client.eval(RECORD_CONFIRMED_SCRIPT, {
      keys: [
        this.key("signature", signals.signatureHash),
        this.userKey("user", actor.id),
        this.userKey("user-confirmed-at", actor.id),
        this.userKey("user-allow", actor.id),
        this.key("profile-users", profile),
        this.key("actor-profiles", actorHash),
        this.key("signature-users", signals.signatureHash),
        this.key("actor-signatures", actorHash),
      ],
      arguments: [
        String(this.config.evidenceRetentionSeconds),
        String(observedAt),
        actorHash,
        profile,
        signals.signatureHash,
      ],
    })
  }

  /** Learns an administrator-confirmed account and its exact profile fingerprint. */
  async recordDeniedActor(actor: CampaignActor): Promise<void> {
    await this.withActorMutation(actor.id, async (assertOwned) => {
      await assertOwned()
      await this.recordDeniedActorUnlocked(actor)
    })
  }

  private async recordDeniedActorUnlocked(actor: CampaignActor): Promise<void> {
    const profile = profileFingerprint(actor.firstName, actor.lastName, this.config.fingerprintSecret)
    const actorHash = this.userFingerprint(actor.id)
    await this.client.eval(RECORD_DENIED_ACTOR_SCRIPT, {
      keys: [
        this.userKey("user", actor.id),
        this.userKey("user-confirmed-at", actor.id),
        this.userKey("user-allow", actor.id),
        this.key("profile-users", profile),
        this.key("actor-profiles", actorHash),
      ],
      arguments: [String(this.config.evidenceRetentionSeconds), String(this.now()), actorHash, profile],
    })
  }

  /** Learns an administrator-confirmed account when profile data is unavailable. */
  async recordDeniedUser(actorId: number): Promise<void> {
    await this.withActorMutation(actorId, async (assertOwned) => {
      await assertOwned()
      await this.recordDeniedUserUnlocked(actorId)
    })
  }

  private async recordDeniedUserUnlocked(actorId: number): Promise<void> {
    await this.client.eval(RECORD_DENIED_USER_SCRIPT, {
      keys: [
        this.userKey("user", actorId),
        this.userKey("user-confirmed-at", actorId),
        this.userKey("user-allow", actorId),
      ],
      arguments: [String(this.config.evidenceRetentionSeconds), String(this.now())],
    })
  }

  /** Applies a moderator reversal and removes reputation learned from the account. */
  async clearConfirmed(actor: CampaignActor | { id: number }): Promise<void> {
    await this.withActorMutation(actor.id, async (assertOwned) => {
      await assertOwned()
      await this.clearConfirmedUnlocked(actor)
    })
  }

  private async clearConfirmedUnlocked(actor: CampaignActor | { id: number }): Promise<void> {
    const actorHash = this.userFingerprint(actor.id)
    const cutoff = this.now() - this.config.evidenceRetentionSeconds * 1000
    const currentProfile =
      "firstName" in actor ? profileFingerprint(actor.firstName, actor.lastName, this.config.fingerprintSecret) : ""
    await this.client.eval(CLEAR_CONFIRMED_SCRIPT, {
      keys: [
        this.userKey("user", actor.id),
        this.userKey("user-confirmed-at", actor.id),
        this.userKey("user-allow", actor.id),
        this.userKey("ban-all-completed", actor.id),
        this.key("actor-signatures", actorHash),
        this.key("actor-profiles", actorHash),
        this.userKey("ban-all-idempotency", actor.id),
      ],
      arguments: [
        actorHash,
        currentProfile,
        String(this.config.evidenceRetentionSeconds),
        String(cutoff),
        CAMPAIGN_REPUTATION_KEY_PREFIX,
      ],
    })
  }

  /** Checks exact account and active profile evidence before a join decision. */
  async inspectJoin(actor: CampaignActor): Promise<CampaignJoinReputation> {
    const profile = profileFingerprint(actor.firstName, actor.lastName, this.config.fingerprintSecret)
    const profileUsersKey = this.key("profile-users", profile)
    const cutoff = this.now() - this.config.evidenceRetentionSeconds * 1000
    await this.client.zRemRangeByScore(profileUsersKey, 0, cutoff)
    const [deniedUser, allowedUser, profileAuthors] = await Promise.all([
      this.client.exists(this.userKey("user", actor.id)),
      this.client.exists(this.userKey("user-allow", actor.id)),
      this.client.zCard(profileUsersKey),
    ])
    return {
      deniedUser:
        (this.config.deniedUserHashes.has(this.userFingerprint(actor.id)) && allowedUser === 0) || deniedUser > 0,
      confirmedProfile: profileAuthors >= this.config.profileAuthorThreshold,
      profileAuthors,
      riskyProfile: isRiskyCampaignProfile(actor.firstName, actor.lastName, actor.username),
    }
  }

  /** Claims a short BanAll lease unless a completed operation is still retained. */
  async claimBanAllOperation(actorId: number): Promise<CampaignBanAllClaim> {
    const claim = await this.claimOperation(
      this.userKey("ban-all-operation", actorId),
      this.userKey("ban-all-completed", actorId)
    )
    if (claim.status !== "claimed") return claim

    const idempotencyKey = this.userKey("ban-all-idempotency", actorId)
    try {
      const retentionSeconds = Math.max(this.config.evidenceRetentionSeconds, BAN_ALL_IDEMPOTENCY_RETENTION_SECONDS)
      await this.client.set(idempotencyKey, randomBytes(18).toString("base64url"), {
        EX: retentionSeconds,
        NX: true,
      })
      const stored = await this.client.get(idempotencyKey)
      if (!stored) throw new Error("Campaign BanAll idempotency state is unavailable")
      await this.client.expire(idempotencyKey, retentionSeconds)
      return { ...claim, idempotencyKey: stored }
    } catch (error) {
      await this.releaseBanAllOperation(actorId, claim.token).catch(() => {})
      throw error
    }
  }

  /** Marks BanAll complete only when the caller still owns its lease. */
  async completeBanAllOperation(actorId: number, token: string): Promise<boolean> {
    return this.completeOperation(
      this.userKey("ban-all-operation", actorId),
      this.userKey("ban-all-completed", actorId),
      token,
      Math.max(this.config.evidenceRetentionSeconds, BAN_ALL_IDEMPOTENCY_RETENTION_SECONDS)
    )
  }

  /** Releases a failed BanAll operation only when the caller still owns its lease. */
  async releaseBanAllOperation(actorId: number, token: string): Promise<void> {
    await this.releaseLease(this.userKey("ban-all-operation", actorId), token)
  }

  /** Renews and verifies ownership before another BanAll side effect. */
  async assertBanAllOperation(actorId: number, token: string): Promise<void> {
    await this.assertLeaseOwned(this.userKey("ban-all-operation", actorId), token)
  }

  private reviewKey(kind: string, reviewId: string): string {
    return this.key(kind, this.reviewFingerprint(reviewId))
  }

  private async markCurrentReviewUnlocked(chatId: number, actorId: number, reviewId: string): Promise<void> {
    await this.client.set(this.currentReviewKey(chatId, actorId), this.reviewFingerprint(reviewId), {
      EX: CAMPAIGN_REVIEW_RETENTION_SECONDS,
    })
  }

  private async isCurrentReviewUnlocked(chatId: number, actorId: number, reviewId: string): Promise<boolean> {
    return (await this.client.get(this.currentReviewKey(chatId, actorId))) === this.reviewFingerprint(reviewId)
  }

  private async clearCurrentReviewUnlocked(chatId: number, actorId: number, reviewId: string): Promise<void> {
    await this.client.eval(RELEASE_LEASE_SCRIPT, {
      keys: [this.currentReviewKey(chatId, actorId)],
      arguments: [this.reviewFingerprint(reviewId)],
    })
  }

  /** Claims a short decision lease unless this review already completed. */
  async claimReviewOperation(reviewId: string): Promise<CampaignOperationClaim> {
    return this.claimOperation(this.reviewKey("review-operation", reviewId), this.reviewKey("review-decided", reviewId))
  }

  /** Marks a review complete only when the caller still owns its decision lease. */
  async completeReviewOperation(reviewId: string, token: string): Promise<boolean> {
    return this.completeOperation(
      this.reviewKey("review-operation", reviewId),
      this.reviewKey("review-decided", reviewId),
      token,
      CAMPAIGN_REVIEW_RETENTION_SECONDS
    )
  }

  /** Releases a failed review operation only when the caller still owns its lease. */
  async releaseReviewOperation(reviewId: string, token: string): Promise<void> {
    await this.releaseLease(this.reviewKey("review-operation", reviewId), token)
  }

  /** Renews and verifies ownership before another moderator-review side effect. */
  async assertReviewOperation(reviewId: string, token: string): Promise<void> {
    await this.assertLeaseOwned(this.reviewKey("review-operation", reviewId), token)
  }

  /** Restores permissions only while this is the latest review and no newer confirmation exists. */
  async releaseConfirmedIfCurrent(
    actor: CampaignActor,
    reviewCreatedAt: number,
    review: CampaignReviewReference | undefined,
    restorePermissions: () => Promise<boolean>
  ): Promise<CampaignReleaseResult> {
    return this.withActorMutation(actor.id, async (assertOwned) => {
      await assertOwned()
      if (review && !(await this.isCurrentReviewUnlocked(review.chatId, actor.id, review.reviewId))) return "stale"
      const confirmedAt = await this.client.get(this.userKey("user-confirmed-at", actor.id))
      if (confirmedAt !== null) {
        const confirmedAtMs = Number(confirmedAt)
        if (!Number.isFinite(confirmedAtMs) || confirmedAtMs >= reviewCreatedAt) return "stale"
      }
      await assertOwned()
      if (!(await restorePermissions())) return "not_released"
      await assertOwned()
      await this.clearConfirmedUnlocked(actor)
      if (review) {
        await this.clearPending(review.chatId, actor.id)
        await this.clearCurrentReviewUnlocked(review.chatId, actor.id, review.reviewId)
      }
      return "released"
    })
  }

  /** Marks a new member for either automatic first-post release or manual review. */
  async markPending(chatId: number, actorId: number, state: CampaignPendingState = "first_post"): Promise<void> {
    await this.client.set(this.pendingKey(chatId, actorId), state, {
      EX: state === "first_post" ? this.config.pendingMemberSeconds : CAMPAIGN_REVIEW_RETENTION_SECONDS,
    })
  }

  /** Returns the active restriction state, accepting old pending markers as first-post state. */
  async pendingState(chatId: number, actorId: number): Promise<CampaignPendingState | null> {
    const state = await this.client.get(this.pendingKey(chatId, actorId))
    if (state === null) return null
    return state === "review" ? "review" : "first_post"
  }

  /** Clears the first-post marker after release or a failed restriction. */
  async clearPending(chatId: number, actorId: number): Promise<void> {
    await this.client.del(this.pendingKey(chatId, actorId))
  }
}
