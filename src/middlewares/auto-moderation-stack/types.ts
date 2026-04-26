export type MultiChatMsgCollection = {
  chatId: number
  messages: { id: number; message: string; timestamp: Date }[]
  unknownMessages: number[]
}
