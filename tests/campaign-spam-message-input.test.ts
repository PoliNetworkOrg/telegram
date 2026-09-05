import type { Message } from "grammy/types"
import { describe, expect, it } from "vitest"
import { classifyCampaignMessage, EMPTY_CAMPAIGN_REPUTATION } from "@/middlewares/campaign-spam/classifier"
import { campaignMessageInput } from "@/middlewares/campaign-spam/message-input"
import { campaignTestFingerprint } from "./fixtures/campaign-spam"

const messageBase = {
  message_id: 1,
  date: 1_788_340_000,
  chat: { id: -1001, type: "supergroup" as const, title: "Test" },
  from: { id: 8_622_804_182, is_bot: false, first_name: "Sender" },
}

describe("campaign Telegram payload extraction", () => {
  it("classifies the observed contact-card lure without retaining its raw phone number", () => {
    const message: Message = {
      ...messageBase,
      contact: {
        phone_number: "+14849105421",
        first_name: "PG电子来注册送28U",
        last_name: "Arpuladevi",
        user_id: 7_288_170_298,
      },
    }

    const input = campaignMessageInput(message)
    const signals = campaignTestFingerprint.extractSignals(input)

    expect(input).toMatchObject({
      source: "contact",
      contactPhoneNumber: "+14849105421",
    })
    expect(signals).toMatchObject({
      hasHan: true,
      hasCampaignLure: true,
      hasContactCard: true,
    })
    expect(JSON.stringify(signals)).not.toContain("+14849105421")
    expect(classifyCampaignMessage(signals, EMPTY_CAMPAIGN_REPUTATION)).toEqual({
      decision: "quarantine",
      reasons: ["campaign_lure", "contact_card"],
    })
  })

  it("extracts text-link targets into protected Telegram handle evidence", () => {
    const message: Message = {
      ...messageBase,
      text: "工作入口",
      entities: [
        {
          type: "text_link",
          offset: 0,
          length: 4,
          url: "https://t.me/cash_agent",
        },
      ],
    }

    const signals = campaignTestFingerprint.extractSignals(campaignMessageInput(message))

    expect(signals).toMatchObject({ source: "text", hasHan: true, hasLink: true, hasMention: false })
    expect(signals.mentionedHandleHashes).toEqual([campaignTestFingerprint.handle("cash_agent")])
    expect(classifyCampaignMessage(signals, EMPTY_CAMPAIGN_REPUTATION, { firstPost: true })).toEqual({
      decision: "quarantine",
      reasons: ["external_link", "first_post"],
    })
  })

  it.each([
    "https://t.me/s/cash_agent",
    "www.t.me/cash_agent",
    "tg://resolve?domain=cash_agent",
  ])("extracts Telegram channel targets from %s", (url) => {
    const signals = campaignTestFingerprint.extractSignals({
      text: "工作入口",
      entityTypes: ["text_link"],
      linkUrls: [url],
    })

    expect(signals.hasLink).toBe(true)
    expect(signals.mentionedHandleHashes).toEqual([campaignTestFingerprint.handle("cash_agent")])
  })

  it("keeps an ordinary Han contact card allowed for an established member", () => {
    const message: Message = {
      ...messageBase,
      contact: {
        phone_number: "+39000000000",
        first_name: "王小明",
      },
    }

    const signals = campaignTestFingerprint.extractSignals(campaignMessageInput(message))

    expect(signals).toMatchObject({ hasHan: true, hasContactCard: true, hasCampaignLure: false })
    expect(classifyCampaignMessage(signals, EMPTY_CAMPAIGN_REPUTATION).decision).toBe("allow")
  })
})
