export function padChatId(chatId: number): number {
  if (chatId < 0) return chatId

  const str = chatId.toString()
  if (str.length === 13) return -chatId

  const padding = "1" + "0".repeat(12 - str.length)

  // Prepend the padding to the input string
  return parseInt(`-${padding}${chatId}`)
}
