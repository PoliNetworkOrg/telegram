import type { Message } from "grammy/types"

type TextReturn<M extends Message> = M extends { text: string }
  ? { text: string; type: "TEXT" }
  : M extends { caption: string }
    ? { text: string; type: "CAPTION" }
    : { text: string; type: "TEXT" | "CAPTION" } | { text: null; type: "OTHER" } // cannot infer

export function getText<M extends Message>(message: M): TextReturn<M> {
  if ("text" in message && message.text) return { text: message.text, type: "TEXT" } as TextReturn<M>
  if ("caption" in message && message.caption) return { text: message.caption, type: "CAPTION" } as TextReturn<M>

  return { text: null, type: "OTHER" } as TextReturn<M>
}
