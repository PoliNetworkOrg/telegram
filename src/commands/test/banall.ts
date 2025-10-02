import type { User } from "grammy/types"
import z from "zod"
import { api } from "@/backend"
import { modules } from "@/modules"
import { getTelegramId } from "@/utils/telegram-id"
import { _commandsBase } from "../_base"

const numberOrString = z.string().transform((s) => {
  const n = Number(s)
  if (!Number.isNaN(n) && s.trim() !== "") return n
  return s
})

_commandsBase.createCommand({
  trigger: "test_banall",
  description: "TEST - PREMA BAN a user from all the Network's groups",
  scope: "private",
  permissions: {
    allowedRoles: ["owner"],
  },
  args: [
    {
      key: "username",
      type: numberOrString,
      description: "The username or the user id of the user you want to update the role",
    },
  ],
  handler: async ({ args, context }) => {
    await context.deleteMessage()

    const userId: number | null =
      typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username

    if (userId === null) {
      await context.reply("Not a valid userId or username not in our cache")
      return
    }

    const dbUser = await api.tg.users.get.query({ userId })
    if (!dbUser || dbUser.error) {
      await context.reply("This user is not in our cache, we cannot proceed.")
      return
    }

    const target: User = {
      id: userId,
      first_name: dbUser.user.firstName,
      last_name: dbUser.user.lastName,
      username: dbUser.user.username,
      is_bot: dbUser.user.isBot,
      language_code: dbUser.user.langCode,
    }

    await modules.get("tgLogger").banAll(target, context.from, "BAN", "Testing")
  },
})
