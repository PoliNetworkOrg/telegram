import type { Message } from "telegraf/types";

export function getMsgText(message: Message): string | null {
  return 'text' in message && message.text !== undefined ? message.text : null
}

