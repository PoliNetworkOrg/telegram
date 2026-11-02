import { resolveOne } from "@/access"
import { PERMISSION } from "@/access/catalog"
import { serviceBackend } from "@/backend"
import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString } from "@/utils/types"

export const role = new CommandsCollection<CommandAccess>("Roles").createCommand({
  trigger: "getroles",
  scope: "private",
  description: "Get roles of an user",
  args: [
    {
      key: "username",
      type: numberOrString,
      description: "The username or the user id of the user you want to update the role",
    },
  ],
  permissions: { requiredPermissions: [PERMISSION.usersRead] },
  handler: async ({ context, args }) => {
    const userId: number | null =
      typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

    if (userId === null) {
      await context.reply(fmt(({ n }) => n`Not a valid userId or username not in our cache`))
      return
    }

    const permissions = [...(await resolveOne(serviceBackend, userId)).permissions].sort()
    await context.reply(
      fmt(({ b, n }) =>
        permissions.length ? n`Permissions: ${b`${permissions.join(" ")}`}` : "This user has no permissions"
      )
    )
  },
})
