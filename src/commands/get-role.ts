import { api } from "@/backend"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"

import { _commandsBase } from "./_base"

_commandsBase.createCommand({
  trigger: "getrole",
  scope: "private",
  description: "Get role of userid",
  args: [{ key: "userId" }],
  handler: async ({ context, args }) => {
    let userId: number | null = parseInt(args.userId)
    if (isNaN(userId)) {
      userId = await getTelegramId(args.userId.replaceAll("@", ""))
    }
    if (userId === null) {
      await context.reply("Not a valid userId or username not in our cache")
      return
    }

    try {
      const { role } = await api.tg.permissions.getRole.query({ userId })
      await context.reply(fmt(({ b }) => [`Role:`, b`${role}`]))
    } catch (err) {
      await context.reply(`There was an error: \n${String(err)}`)
    }
  },
})
