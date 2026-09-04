import type { User } from "grammy/types"
import type { CampaignMessageSignals, CampaignReputationSnapshot } from "./classifier"
import { EMPTY_CAMPAIGN_REPUTATION, profileFingerprint } from "./classifier"
import type { CampaignSpamConfig } from "./config"

const KEY_PREFIX = "moderation:campaign:v1"

export type CampaignRedis = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<string | null>
  del(key: string): Promise<number>
  exists(key: string): Promise<number>
  sAdd(key: string, member: string): Promise<number>
  sMembers(key: string): Promise<string[]>
  zAdd(key: string, member: { score: number; value: string }): Promise<number>
  zCard(key: string): Promise<number>
  zRem(key: string, member: string): Promise<number>
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number>
  expire(key: string, seconds: number): Promise<boolean>
}

export type CampaignActor = {
  id: number
  firstName: string
  lastName?: string
}

/** Copies the Telegram identity fields retained by campaign reputation. */
export function campaignActorFromUser(user: User): CampaignActor {
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
  }
}

export type CampaignConfirmationSignals = Pick<CampaignMessageSignals, "signatureHash">

export type CampaignJoinReputation = {
  deniedUser: boolean
  confirmedProfile: boolean
  profileAuthors: number
}

/** Stores short-lived campaign evidence and learned moderation decisions in Redis. */
export class CampaignReputation {
  constructor(
    private readonly client: CampaignRedis,
    private readonly config: CampaignSpamConfig,
    private readonly now: () => number = Date.now
  ) {}

  private key(kind: string, value: string | number): string {
    return `${KEY_PREFIX}:${kind}:${value}`
  }

  private configuredSnapshot(signals: CampaignMessageSignals, actorId: number): CampaignReputationSnapshot {
    return {
      ...EMPTY_CAMPAIGN_REPUTATION,
      confirmedSignature: this.config.confirmedSignatureHashes.has(signals.signatureHash),
      deniedUser: this.config.deniedUserIds.has(actorId),
      knownHandle: signals.mentionedHandleHashes.some((hash) => this.config.deniedHandleHashes.has(hash)),
      knownButtonDomain: signals.buttonDomainHashes.some((hash) => this.config.deniedButtonDomainHashes.has(hash)),
      knownViaBot: signals.viaBotId !== undefined && this.config.deniedViaBotIds.has(signals.viaBotId),
    }
  }

  private async recordBurst(signals: CampaignMessageSignals, actorId: number, chatId: number) {
    const authorsKey = this.key("burst-authors", signals.signatureHash)
    const chatsKey = this.key("burst-chats", signals.signatureHash)
    const observedAt = this.now()
    const cutoff = observedAt - this.config.burstWindowSeconds * 1000

    await Promise.all([
      this.client.zAdd(authorsKey, { score: observedAt, value: String(actorId) }),
      this.client.zAdd(chatsKey, { score: observedAt, value: String(chatId) }),
      this.client.zRemRangeByScore(authorsKey, 0, cutoff),
      this.client.zRemRangeByScore(chatsKey, 0, cutoff),
      this.client.expire(authorsKey, this.config.burstWindowSeconds),
      this.client.expire(chatsKey, this.config.burstWindowSeconds),
    ])

    const [distinctAuthors, distinctChats] = await Promise.all([
      this.client.zCard(authorsKey),
      this.client.zCard(chatsKey),
    ])
    return { distinctAuthors, distinctChats }
  }

  private async recordEvidence(signals: CampaignMessageSignals): Promise<void> {
    const signatureHash = signals.signatureHash
    const observedAt = String(this.now())
    const evidence = {
      handles: signals.mentionedHandleHashes,
      mentionedUsers: signals.mentionedUserIdHashes,
      buttonUrls: signals.buttonUrlHashes,
      buttonDomains: signals.buttonDomainHashes,
      viaBotIds: signals.viaBotId === undefined ? [] : [String(signals.viaBotId)],
      viaBotUsernames: signals.viaBotUsernameHash ? [signals.viaBotUsernameHash] : [],
      entities: signals.entityTypes,
      flags: signals.hasInlineKeyboard ? ["inline_keyboard"] : [],
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
    const isBurstCandidate = signals.hasHan && signals.hasMention

    const [confirmedSignature, deniedUser, allowedUser, joinedAt] = await Promise.all([
      this.client.exists(this.key("signature", signals.signatureHash)),
      this.client.exists(this.key("user", actorId)),
      this.client.exists(this.key("user-allow", actorId)),
      this.client.get(this.key("joined-at", actorId)),
    ])

    let distinctAuthors = 0
    let distinctChats = 0
    if (isBurstCandidate) {
      const burst = await this.recordBurst(signals, actorId, chatId)
      distinctAuthors = burst.distinctAuthors
      distinctChats = burst.distinctChats
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
      knownButtonDomain: configured.knownButtonDomain,
      knownHandle: configured.knownHandle,
      knownViaBot: configured.knownViaBot,
      distinctAuthors,
      distinctChats,
    }
  }

  /** Returns only static indicators when Redis is unavailable. */
  configuredOnly(signals: CampaignMessageSignals, actorId: number): CampaignReputationSnapshot {
    return this.configuredSnapshot(signals, actorId)
  }

  /** Marks an account as fresh for the configured first-post window. */
  async recordJoin(actorId: number): Promise<void> {
    await this.client.set(this.key("joined-at", actorId), String(this.now()), {
      EX: this.config.freshWindowSeconds,
    })
  }

  /** Learns a confirmed account, profile, and message signature. */
  async recordConfirmed(signals: CampaignConfirmationSignals, actor: CampaignActor): Promise<void> {
    const observedAt = this.now()
    const profile = profileFingerprint(actor.firstName, actor.lastName)
    const profileUsersKey = this.key("profile-users", profile)
    const actorProfilesKey = this.key("actor-profiles", actor.id)
    const signatureUsersKey = this.key("signature-users", signals.signatureHash)
    const actorSignaturesKey = this.key("actor-signatures", actor.id)
    const expiringWrites: Promise<unknown>[] = [
      this.client.set(this.key("signature", signals.signatureHash), "1", {
        EX: this.config.evidenceRetentionSeconds,
      }),
      this.client.set(this.key("user", actor.id), "1", { EX: this.config.evidenceRetentionSeconds }),
      this.client.del(this.key("user-allow", actor.id)),
      this.client.zAdd(profileUsersKey, { score: observedAt, value: String(actor.id) }),
      this.client.sAdd(actorProfilesKey, profile),
      this.client.zAdd(signatureUsersKey, { score: observedAt, value: String(actor.id) }),
      this.client.sAdd(actorSignaturesKey, signals.signatureHash),
      this.client.expire(profileUsersKey, this.config.evidenceRetentionSeconds),
      this.client.expire(actorProfilesKey, this.config.evidenceRetentionSeconds),
      this.client.expire(signatureUsersKey, this.config.evidenceRetentionSeconds),
      this.client.expire(actorSignaturesKey, this.config.evidenceRetentionSeconds),
    ]

    await Promise.all(expiringWrites)
  }

  /** Learns an administrator-confirmed account and its exact profile fingerprint. */
  async recordDeniedActor(actor: CampaignActor): Promise<void> {
    const profile = profileFingerprint(actor.firstName, actor.lastName)
    const profileUsersKey = this.key("profile-users", profile)
    const actorProfilesKey = this.key("actor-profiles", actor.id)
    await Promise.all([
      this.recordDeniedUser(actor.id),
      this.client.zAdd(profileUsersKey, { score: this.now(), value: String(actor.id) }),
      this.client.sAdd(actorProfilesKey, profile),
      this.client.expire(profileUsersKey, this.config.evidenceRetentionSeconds),
      this.client.expire(actorProfilesKey, this.config.evidenceRetentionSeconds),
    ])
  }

  /** Learns an administrator-confirmed account when profile data is unavailable. */
  async recordDeniedUser(actorId: number): Promise<void> {
    await Promise.all([
      this.client.set(this.key("user", actorId), "1", { EX: this.config.evidenceRetentionSeconds }),
      this.client.del(this.key("user-allow", actorId)),
    ])
  }

  /** Applies a moderator reversal and removes reputation learned from the account. */
  async clearConfirmed(actor: CampaignActor | { id: number }): Promise<void> {
    const actorSignaturesKey = this.key("actor-signatures", actor.id)
    const actorProfilesKey = this.key("actor-profiles", actor.id)
    const [signatureHashes, storedProfileHashes] = await Promise.all([
      this.client.sMembers(actorSignaturesKey),
      this.client.sMembers(actorProfilesKey),
    ])
    const profileHashes = new Set(storedProfileHashes)
    if ("firstName" in actor) profileHashes.add(profileFingerprint(actor.firstName, actor.lastName))
    const removals: Promise<unknown>[] = [
      this.client.del(this.key("user", actor.id)),
      this.client.set(this.key("user-allow", actor.id), "1", { EX: this.config.evidenceRetentionSeconds }),
      this.client.del(this.key("ban-all-claimed", actor.id)),
      this.client.del(actorSignaturesKey),
      this.client.del(actorProfilesKey),
    ]
    for (const profileHash of profileHashes) {
      removals.push(this.client.zRem(this.key("profile-users", profileHash), String(actor.id)))
    }
    for (const signatureHash of signatureHashes) {
      removals.push(this.client.zRem(this.key("signature-users", signatureHash), String(actor.id)))
    }
    await Promise.all(removals)

    const cutoff = this.now() - this.config.evidenceRetentionSeconds * 1000
    for (const signatureHash of signatureHashes) {
      const signatureUsersKey = this.key("signature-users", signatureHash)
      await this.client.zRemRangeByScore(signatureUsersKey, 0, cutoff)
      if ((await this.client.zCard(signatureUsersKey)) > 0) continue
      await Promise.all([this.client.del(this.key("signature", signatureHash)), this.client.del(signatureUsersKey)])
    }
  }

  /** Checks exact account and active profile evidence before a join decision. */
  async inspectJoin(actor: CampaignActor): Promise<CampaignJoinReputation> {
    const profile = profileFingerprint(actor.firstName, actor.lastName)
    const profileUsersKey = this.key("profile-users", profile)
    const cutoff = this.now() - this.config.evidenceRetentionSeconds * 1000
    await this.client.zRemRangeByScore(profileUsersKey, 0, cutoff)
    const [deniedUser, allowedUser, profileAuthors] = await Promise.all([
      this.client.exists(this.key("user", actor.id)),
      this.client.exists(this.key("user-allow", actor.id)),
      this.client.zCard(profileUsersKey),
    ])
    return {
      deniedUser: (this.config.deniedUserIds.has(actor.id) && allowedUser === 0) || deniedUser > 0,
      confirmedProfile: profileAuthors >= this.config.profileAuthorThreshold,
      profileAuthors,
    }
  }

  /** Claims one network-wide ban job for an account. */
  async claimBanAll(actorId: number): Promise<boolean> {
    const result = await this.client.set(this.key("ban-all-claimed", actorId), "1", {
      EX: this.config.evidenceRetentionSeconds,
      NX: true,
    })
    return result === "OK"
  }

  /** Releases a failed network-wide ban claim so operators can retry it. */
  async releaseBanAllClaim(actorId: number): Promise<void> {
    await this.client.del(this.key("ban-all-claimed", actorId))
  }

  /** Marks a newly approved member as awaiting first-post classification. */
  async markPending(chatId: number, actorId: number): Promise<void> {
    await this.client.set(this.key("pending", `${chatId}:${actorId}`), "1", {
      EX: this.config.pendingMemberSeconds,
    })
  }

  /** Checks whether a member still has first-post restrictions. */
  async isPending(chatId: number, actorId: number): Promise<boolean> {
    return (await this.client.exists(this.key("pending", `${chatId}:${actorId}`))) > 0
  }

  /** Clears the first-post marker after release or a failed restriction. */
  async clearPending(chatId: number, actorId: number): Promise<void> {
    await this.client.del(this.key("pending", `${chatId}:${actorId}`))
  }
}
