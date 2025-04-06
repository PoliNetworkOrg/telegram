import type { Message } from "grammy/types"

type TextReturn =
  | {
      text: string
      type: "TEXT" | "CAPTION"
    }
  | { text: null; type: "OTHER" }

export function getText(message: Message): TextReturn {
  if ("text" in message && message.text) return { text: message.text, type: "TEXT" }
  if ("caption" in message && message.caption) return { text: message.caption, type: "CAPTION" }

  return { text: null, type: "OTHER" }
}

export function sanitizeText(text: string): string {
  return text.replace(/[[\]()~`>#+\-=|{}.!_]/g, "\\$&")
}
