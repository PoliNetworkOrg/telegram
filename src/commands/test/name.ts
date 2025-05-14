import { fmt } from "@/utils/format"

import { _commandsBase } from "../_base"

_commandsBase.createCommand({
  trigger: "test_name",
  scope: "private",
  permissions: {
    allowedRoles: ["admin"],
  },
  description: "Quick conversation",
  handler: async ({ conversation, context }) => {
    const question = await context.reply("What is your name?")
    const { message } = await conversation.waitFor("message:text")
    await context.deleteMessage()
    await message.delete()
    await question.delete()
    await context.reply(fmt(() => `Hello, ${message.text}!`))
  },
})
