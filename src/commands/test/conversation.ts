import { CommandsCollection } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"
import type { Role } from "@/utils/types"

export const testconvo = new CommandsCollection<Role>().createCommand({
  trigger: "test_convo",
  scope: "private",
  description: "Test conversation",
  handler: async ({ context, conversation }) => {
    const now = await conversation.now()
    await context.reply(`What is your name?`)
    const answer = await conversation.waitFor("message:text")
    const name = answer.message.text
    await context.reply(fmt(() => [`Hello, ${name}! This conversation has been active for ${Date.now() - now} ms.`]))
  },
})
