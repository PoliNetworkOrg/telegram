import type { Message, MessageEntity } from "grammy/types"
import type { CampaignMessageInput } from "./classifier"

function messageEntities(message: Message): readonly MessageEntity[] {
  if ("entities" in message) return message.entities ?? []
  if ("caption_entities" in message) return message.caption_entities ?? []
  return []
}

function linkedUrls(text: string, entities: readonly MessageEntity[]): string[] {
  return entities.flatMap((entity) => {
    if (entity.type === "text_link") return [entity.url]
    if (entity.type === "url") return [text.slice(entity.offset, entity.offset + entity.length)]
    return []
  })
}

function inlineKeyboardSignals(message: Message): { buttonUrls: string[]; hasInlineKeyboard: boolean } {
  if (!("reply_markup" in message) || !message.reply_markup) {
    return { buttonUrls: [], hasInlineKeyboard: false }
  }
  const rows = message.reply_markup.inline_keyboard
  return {
    hasInlineKeyboard: rows.some((row) => row.length > 0),
    buttonUrls: rows.flatMap((row) =>
      row.flatMap((button) => {
        if ("url" in button && button.url) return [button.url]
        if ("login_url" in button && button.login_url) return [button.login_url.url]
        if ("web_app" in button && button.web_app) return [button.web_app.url]
        return []
      })
    ),
  }
}

/** Extracts every campaign-relevant Telegram payload without retaining the raw message. */
export function campaignMessageInput(message: Message): CampaignMessageInput {
  const content =
    "text" in message && message.text
      ? { text: message.text, source: "text" as const }
      : "caption" in message && message.caption
        ? { text: message.caption, source: "caption" as const }
        : { text: null, source: "text" as const }
  const contact = "contact" in message ? message.contact : undefined
  const text =
    content.text ??
    (contact ? [contact.first_name, contact.last_name, contact.phone_number].filter(Boolean).join(" ") : "")
  const entities = messageEntities(message)
  const inlineKeyboard = inlineKeyboardSignals(message)

  return {
    text,
    source: contact ? "contact" : content.source,
    contactPhoneNumber: contact?.phone_number,
    entityTypes: entities.map((entity) => entity.type),
    mentionedUserIds: entities.flatMap((entity) => (entity.type === "text_mention" ? [entity.user.id] : [])),
    linkUrls: linkedUrls(text, entities),
    buttonUrls: inlineKeyboard.buttonUrls,
    hasInlineKeyboard: inlineKeyboard.hasInlineKeyboard,
    viaBotId: message.via_bot?.id,
    viaBotUsername: message.via_bot?.username,
  }
}
