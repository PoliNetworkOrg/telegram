import { PERMISSION } from "@/access/catalog"
import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import type { Role } from "@/utils/types"

export const userid = new CommandsCollection<Role, CommandAccess>("User IDs").createCommand({
  trigger: "userid",
  scope: "private",
  description: "Gets the ID of a username",
  args: [{ key: "username", description: "The username to get the ID of" }],
  // Open to everyone before the IdP migration; RFC v3 §10.2 restricts it.
  permissions: { requiredPermissions: [PERMISSION.usersRead] },
  handler: async ({ context, args }) => {
    const username = args.username.replace("@", "")
    const id = await getTelegramId(username)
    if (!id) {
      logger.warn(`[/userid] username @${username} not in our cache`)
      await context.reply(fmt(({ u }) => u`Username @${username} not in our cache`))
      return
    }

    await context.reply(fmt(({ code }) => [`Username: @${username}`, `\nid:`, code`${id}`]))
  },
})
