import { api } from "@/backend"
import { fmt, fmtDate } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"

import { _commandsBase } from "./_base"

_commandsBase.createCommand({
  trigger: "audit",
  scope: "private",
  description: "Get audit of an user",
  args: [{ key: "username", optional: false, description: "Username or userid" }],
  permissions: {
    allowedRoles: ["hr", "owner", "direttivo"],
  },
  handler: async ({ context, args }) => {
    let userId: number | null = parseInt(args.username)
    if (isNaN(userId)) {
      userId = await getTelegramId(args.username)
    }

    if (userId === null) {
      await context.reply("Not a valid userId or username not in our cache")
      return
    }

    try {
      const list = await api.tg.auditLog.getById.query({ targetId: userId })
      await context.reply(
        fmt(
          ({ b, n, i, u }) => [
            b`🧾 Audit Log: ${args.username}\n`,
            ...list.flatMap((el) => [
              `------------------------------------`,
              n`${u`${b`${el.type.toUpperCase()}`}`} ${i`at ${fmtDate(el.createdAt)}`}`,
              el.until ? n`${b`Until:`} ${fmtDate(el.until)}` : undefined,
              el.groupId ? n`${b`Group ID:`} ${el.groupId}` : undefined,
              n`${b`Admin ID:`} ${el.adminId}`,
              el.reason ? n`${b`Reason:`} ${el.reason}` : undefined,
            ]),
            `------------------------------------`,
          ],
          {
            sep: "\n",
          }
        )
      )
    } catch (err) {
      await context.reply(`There was an error: \n${String(err)}`)
    }
  },
})
