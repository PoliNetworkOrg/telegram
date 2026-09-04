import { describe, expect, it } from "vitest"
import {
  classifyCampaignJoin,
  classifyCampaignMessage,
  createCampaignFingerprintSecret,
  EMPTY_CAMPAIGN_REPUTATION,
  normalizeCampaignText,
  campaignIndicatorHash as protectedCampaignIndicatorHash,
} from "@/middlewares/campaign-spam/classifier"
import { CAMPAIGN_TEST_SECRET, campaignTestFingerprint } from "./fixtures/campaign-spam"

const {
  buttonDomain: buttonDomainFingerprint,
  buttonUrl: buttonUrlFingerprint,
  extractSignals: extractCampaignSignals,
  handle: handleFingerprint,
  indicatorHash: campaignIndicatorHash,
  profile: profileFingerprint,
} = campaignTestFingerprint

describe("campaign spam classifier", () => {
  it("normalizes compatibility characters, rotating numbers, handles, and invisible controls", () => {
    expect(normalizeCampaignText("聘群演每日６００+\u200B @Cash_Helper_47")).toBe("聘群演每日#+ <mention>")
    expect(normalizeCampaignText("小额  收点赚\n@work_channel_2")).toBe("小额 收点赚 <mention>")
  })

  it("uses a keyed, versioned digest for persisted indicators", () => {
    const first = protectedCampaignIndicatorHash("user_id", "123456789", CAMPAIGN_TEST_SECRET)
    const second = protectedCampaignIndicatorHash(
      "user_id",
      "123456789",
      createCampaignFingerprintSecret(`${CAMPAIGN_TEST_SECRET}-other`)
    )

    expect(first).not.toBe(second)
    expect(first).not.toContain("123456789")
  })

  it("extracts message and inline-button signals without retaining raw indicators", () => {
    const signals = extractCampaignSignals({
      text: "小额收点赚 @Work_Channel_2",
      entityTypes: ["mention", "bold", "mention"],
      mentionedUserIds: [99, 99],
      buttonUrls: ["https://WWW.Example.com/job/1", "https://example.com/job/2", "tg://resolve?domain=x"],
      viaBotId: 42,
      viaBotUsername: "Campaign_Helper_Bot",
    })

    expect(signals).toMatchObject({
      hasHan: true,
      hasMention: true,
      entityTypes: ["bold", "mention"],
      hasInlineKeyboard: true,
      viaBotIdHash: campaignIndicatorHash("via_bot", "42"),
    })
    expect(signals.mentionedHandleHashes).toEqual([handleFingerprint("work_channel_2")])
    expect(signals.mentionedUserIdHashes).toEqual([campaignIndicatorHash("mention_user", "99")])
    expect(signals.buttonUrlHashes).toEqual([
      buttonUrlFingerprint("https://www.example.com/job/1"),
      buttonUrlFingerprint("https://example.com/job/2"),
      buttonUrlFingerprint("tg://resolve?domain=x"),
    ])
    expect(signals.buttonDomainHashes).toEqual([buttonDomainFingerprint("example.com")])
    expect(signals.viaBotUsernameHash).toBe(handleFingerprint("campaign_helper_bot"))
    expect(signals.signatureHash).toBe(
      campaignIndicatorHash("signature", normalizeCampaignText("小额收点赚 @Work_Channel_2"))
    )
  })

  it("BanAlls only high-confidence campaign matches", () => {
    const signals = extractCampaignSignals({ text: "聘群演每日600+ @cash_helper_47" })

    expect(
      classifyCampaignMessage(signals, {
        ...EMPTY_CAMPAIGN_REPUTATION,
        confirmedSignature: true,
      })
    ).toEqual({ decision: "ban_all", reasons: ["confirmed_signature"] })

    expect(
      classifyCampaignMessage(signals, {
        ...EMPTY_CAMPAIGN_REPUTATION,
        globalBurst: true,
        distinctAuthors: 3,
        distinctChats: 2,
      })
    ).toEqual({ decision: "ban_all", reasons: ["global_burst"] })
  })

  it("BanAlls an administrator-denied handle even when the visible text changes", () => {
    const signals = extractCampaignSignals({ text: "Do not contact @cash_helper_47; this account is spam." })

    expect(
      classifyCampaignMessage(signals, {
        ...EMPTY_CAMPAIGN_REPUTATION,
        knownHandle: true,
      })
    ).toEqual({ decision: "ban_all", reasons: ["known_handle"] })
  })

  it("BanAlls a campaign-shaped message that mentions a denied handle", () => {
    const signals = extractCampaignSignals({ text: "请勿联系 @cash_helper_47，这是垃圾账号。" })

    expect(
      classifyCampaignMessage(signals, {
        ...EMPTY_CAMPAIGN_REPUTATION,
        knownHandle: true,
      })
    ).toEqual({ decision: "ban_all", reasons: ["known_handle"] })
  })

  it("quarantines a fresh Han-script solicitation with a mention", () => {
    const signals = extractCampaignSignals({ text: "小额收点赚 @work_channel_2" })
    const result = classifyCampaignMessage(signals, {
      ...EMPTY_CAMPAIGN_REPUTATION,
      freshUser: true,
    })

    expect(result).toEqual({ decision: "quarantine", reasons: ["han_with_mention", "fresh_user"] })
  })

  it("quarantines Han-script mentions sent through inline bots or with buttons", () => {
    const viaBot = extractCampaignSignals({ text: "徕收歀一天300qoo @cash_agent", viaBotId: 42 })
    const withButton = extractCampaignSignals({
      text: "徕收歀一天300qoo @cash_agent",
      buttonUrls: ["https://example.com/join"],
    })

    expect(classifyCampaignMessage(viaBot, EMPTY_CAMPAIGN_REPUTATION).decision).toBe("quarantine")
    expect(classifyCampaignMessage(withButton, EMPTY_CAMPAIGN_REPUTATION).decision).toBe("quarantine")
  })

  it("detects inline keyboards even when their buttons do not contain URLs", () => {
    const signals = extractCampaignSignals({
      text: "徕收歀一天300qoo @cash_agent",
      hasInlineKeyboard: true,
    })

    expect(signals.hasInlineKeyboard).toBe(true)
    expect(signals.buttonDomainHashes).toEqual([])
    expect(classifyCampaignMessage(signals, EMPTY_CAMPAIGN_REPUTATION).decision).toBe("quarantine")
  })

  it.each([
    ["大家好，我是交换生，请问今天的课程在哪个教室？", EMPTY_CAMPAIGN_REPUTATION],
    ["请问 @mario 今天上课吗？", EMPTY_CAMPAIGN_REPUTATION],
    ["Per l'esame usiamo π e Ω, giusto?", EMPTY_CAMPAIGN_REPUTATION],
    ["A plain first post", { ...EMPTY_CAMPAIGN_REPUTATION, freshUser: true }],
  ])("allows non-campaign input: %s", (text, reputation) => {
    expect(classifyCampaignMessage(extractCampaignSignals({ text }), reputation).decision).toBe("allow")
  })

  it("keeps profile fingerprints exact apart from Unicode, case, and whitespace", () => {
    expect(profileFingerprint("Ｓtudent 123", "  Wang")).toBe(profileFingerprint("student 123", "wang"))
    expect(profileFingerprint("Student 123", "Wang")).not.toBe(profileFingerprint("student 456", "wang"))
  })

  it("reviews partial profile evidence without treating it as a decline signal", () => {
    expect(classifyCampaignJoin({ deniedUser: false, confirmedProfile: false, profileAuthors: 1 })).toEqual({
      decision: "restrict",
      reviewReason: "partial_profile",
    })
    expect(classifyCampaignJoin({ deniedUser: false, confirmedProfile: false, profileAuthors: 0 })).toEqual({
      decision: "restrict",
    })
  })

  it("declines exact denied users and threshold-confirmed profiles", () => {
    expect(classifyCampaignJoin({ deniedUser: true, confirmedProfile: false, profileAuthors: 0 })).toEqual({
      decision: "decline",
      reviewReason: "denied_user",
    })
    expect(classifyCampaignJoin({ deniedUser: false, confirmedProfile: true, profileAuthors: 3 })).toEqual({
      decision: "decline",
      reviewReason: "confirmed_profile",
    })
  })
})
