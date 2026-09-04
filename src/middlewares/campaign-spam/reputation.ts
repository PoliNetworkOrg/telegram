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
  sCard(key: string): Promise<number>
  zAdd(key: string, member: { score: number; value: string }): Promise<number>
  zCard(key: string): Promise<number>
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number>
  expire(key: string, seconds: number): Promise<boolean>
}

export type CampaignActor = {
  id: number
  firstName: string
  lastName?: string
}

export type CampaignJoinReputation = {
  deniedUser: boolean
  confirmedProfile: boolean
  profileAuthors: number
}

export class CampaignReputation {
  constructor(
    private readonly client: CampaignRedis,
    private readonly config: CampaignSpamConfig,
    private readonly now: () => number = Date.now
  ) {}

  private key(kind: string, value: string | number): string {
    return `${KEY_PREFIX}:${kind}:${value}`
  }

  private configuredSnapshot(signals: CampaignMessageSignals): CampaignReputationSnapshot {
    return {
      ...EMPTY_CAMPAIGN_REPUTATION,
      confirmedSignature: this.config.confirmedSignatureHashes.has(signals.signatureHash),
      knownHandle: signals.mentionedHandleHashes.some((hash) => this.config.deniedHandleHashes.has(hash)),
      knownButtonDomain: signals.buttonDomainHashes.some((hash) => this.config.deniedButtonDomainHashes.has(hash)),
      knownViaBot: signals.viaBotId !== undefined && this.config.deniedViaBotIds.has(signals.viaBotId),
    }
  }

  async inspectAndRecord(
    signals: CampaignMessageSignals,
    actorId: number,
    chatId: number
  ): Promise<CampaignReputationSnapshot> {
    const configured = this.configuredSnapshot(signals)
    const candidate = signals.hasHan && signals.hasMention

    const [confirmedSignature, deniedUser, joinedAt] = await Promise.all([
      this.client.exists(this.key("signature", signals.signatureHash)),
      this.client.exists(this.key("user", actorId)),
      this.client.get(this.key("joined-at", actorId)),
    ])

    let distinctAuthors = 0
    let distinctChats = 0
    if (candidate) {
      const authorsKey = this.key("burst-authors", signals.signatureHash)
      const chatsKey = this.key("burst-chats", signals.signatureHash)
      const observedAt = this.now()
      const cutoff = observedAt - this.config.burstWindowSeconds * 1000
      const evidenceKeys = [
        this.key("evidence-handles", signals.signatureHash),
        this.key("evidence-buttons", signals.signatureHash),
        this.key("evidence-via-bots", signals.signatureHash),
        this.key("evidence-entities", signals.signatureHash),
        this.key("evidence-flags", signals.signatureHash),
      ]
      const evidenceWrites: Promise<unknown>[] = [
        this.client.zAdd(authorsKey, { score: observedAt, value: String(actorId) }),
        this.client.zAdd(chatsKey, { score: observedAt, value: String(chatId) }),
        this.client.zRemRangeByScore(authorsKey, 0, cutoff),
        this.client.zRemRangeByScore(chatsKey, 0, cutoff),
        this.client.expire(authorsKey, this.config.burstWindowSeconds),
        this.client.expire(chatsKey, this.config.burstWindowSeconds),
        this.client.set(this.key("evidence", signals.signatureHash), String(this.now()), {
          EX: this.config.evidenceRetentionSeconds,
        }),
      ]
      for (const hash of signals.mentionedHandleHashes) {
        evidenceWrites.push(this.client.sAdd(evidenceKeys[0], hash))
      }
      for (const hash of signals.buttonDomainHashes) {
        evidenceWrites.push(this.client.sAdd(evidenceKeys[1], hash))
      }
      if (signals.viaBotId !== undefined) {
        evidenceWrites.push(this.client.sAdd(evidenceKeys[2], String(signals.viaBotId)))
      }
      for (const entityType of signals.entityTypes) {
        evidenceWrites.push(this.client.sAdd(evidenceKeys[3], entityType))
      }
      if (signals.hasInlineKeyboard) {
        evidenceWrites.push(this.client.sAdd(evidenceKeys[4], "inline_keyboard"))
      }
      evidenceWrites.push(...evidenceKeys.map((key) => this.client.expire(key, this.config.evidenceRetentionSeconds)))
      await Promise.all(evidenceWrites)
      ;[distinctAuthors, distinctChats] = await Promise.all([
        this.client.zCard(authorsKey),
        this.client.zCard(chatsKey),
      ])
    }

    const joinedAtMs = joinedAt === null ? Number.NaN : Number(joinedAt)
    const freshUser = Number.isFinite(joinedAtMs) && this.now() - joinedAtMs <= this.config.freshWindowSeconds * 1000

    return {
      confirmedSignature: configured.confirmedSignature || confirmedSignature > 0,
      deniedUser: deniedUser > 0,
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

  configuredOnly(signals: CampaignMessageSignals): CampaignReputationSnapshot {
    return this.configuredSnapshot(signals)
  }

  async recordJoin(actorId: number): Promise<void> {
    await this.client.set(this.key("joined-at", actorId), String(this.now()), {
      EX: this.config.evidenceRetentionSeconds,
    })
  }

  async recordConfirmed(signals: CampaignMessageSignals, actor: CampaignActor): Promise<void> {
    const profile = profileFingerprint(actor.firstName, actor.lastName)
    const profileUsersKey = this.key("profile-users", profile)
    const expiringWrites: Promise<unknown>[] = [
      this.client.set(this.key("signature", signals.signatureHash), "1", {
        EX: this.config.evidenceRetentionSeconds,
      }),
      this.client.set(this.key("user", actor.id), "1", { EX: this.config.evidenceRetentionSeconds }),
      this.client.sAdd(profileUsersKey, String(actor.id)),
      this.client.expire(profileUsersKey, this.config.evidenceRetentionSeconds),
    ]

    await Promise.all(expiringWrites)
  }

  async inspectJoin(actor: CampaignActor): Promise<CampaignJoinReputation> {
    const profile = profileFingerprint(actor.firstName, actor.lastName)
    const [deniedUser, profileAuthors] = await Promise.all([
      this.client.exists(this.key("user", actor.id)),
      this.client.sCard(this.key("profile-users", profile)),
    ])
    return {
      deniedUser: deniedUser > 0,
      confirmedProfile: profileAuthors >= this.config.profileAuthorThreshold,
      profileAuthors,
    }
  }

  async claimBanAll(actorId: number): Promise<boolean> {
    const result = await this.client.set(this.key("ban-all-claimed", actorId), "1", {
      EX: this.config.evidenceRetentionSeconds,
      NX: true,
    })
    return result === "OK"
  }

  async releaseBanAllClaim(actorId: number): Promise<void> {
    await this.client.del(this.key("ban-all-claimed", actorId))
  }

  async markPending(chatId: number, actorId: number): Promise<void> {
    await this.client.set(this.key("pending", `${chatId}:${actorId}`), "1", {
      EX: this.config.pendingMemberSeconds,
    })
  }

  async isPending(chatId: number, actorId: number): Promise<boolean> {
    return (await this.client.exists(this.key("pending", `${chatId}:${actorId}`))) > 0
  }

  async clearPending(chatId: number, actorId: number): Promise<void> {
    await this.client.del(this.key("pending", `${chatId}:${actorId}`))
  }
}
