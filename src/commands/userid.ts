import { logger } from "@/logger"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"

import { _commandsBase } from "./_base"

_commandsBase.createCommand({
  trigger: "userid",
  scope: "private",
  description: "Gets the ID of a username",
  args: [{ key: "username", description: "The username to get the ID of" }],
  handler: async ({ context, args }) => {
    const username = args.username.replace("@", "")
    const id = await getTelegramId(username)
    if (!id) {
      logger.warn(`[/userid] username @${username} not in our cache`)
      await context.reply(fmt(() => `Username @${username} not in our cache`))
      return
    }

    await context.reply(fmt(({ code }) => [`Username: @${username}`, `\nid:`, code`${id}`]))
  },
})
