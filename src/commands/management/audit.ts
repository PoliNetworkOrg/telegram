import { PERMISSION } from "@/access/catalog"
import { backendAs } from "@/backend"
import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { fmt, fmtDate } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"

export const audit = new CommandsCollection<string, CommandAccess>("Auditing").createCommand({
  trigger: "audit",
  scope: "private",
  description: "Get the audit log of a user",
  args: [{ key: "username", optional: false, description: "Username or userid" }],
  permissions: {
    requiredPermissions: [PERMISSION.auditRead],
  },
  handler: async ({ context, args }) => {
    let userId: number | null = parseInt(args.username, 10)
    if (Number.isNaN(userId)) {
      userId = await getTelegramId(args.username)
    }

    if (userId === null) {
      await context.reply(fmt(({ n }) => n`Not a valid userId or username not in our cache`))
      return
    }

    // The backend checks `tg:audit:read` for the actor as well.
    const list = await backendAs(context.from.id).tg.auditLog.getById.query({ targetId: userId })
    await context.reply(
      fmt(
        ({ b, n, i, u, link, code }) => [
          b`🧾 Audit Log: ${args.username}\n`,
          ...list.flatMap((el) => {
            // Automatic actions have no human actor (RFC v3 §9.2); older rows only have adminId.
            const actorId = el.actorTgId ?? el.adminId
            return [
              `------------------------------------`,
              n`${u`${b`${el.type.toUpperCase()}`}`} ${i`at ${fmtDate(el.createdAt)}`}`,
              el.until ? n`${b`Until:`} ${fmtDate(el.until)}` : undefined,
              el.groupId ? n`${b`Group:`} ${el.groupTitle} [${code`${el.groupId}`}]` : undefined,
              actorId === null
                ? n`${b`Admin ID:`} none`
                : n`${b`Admin ID:`} ${link(actorId.toString(), `tg://user?id=${actorId}`)}`,
              n`${b`Basis:`} ${el.basis}`,
              el.reason ? n`${b`Reason:`} ${el.reason}` : undefined,
            ]
          }),
          `------------------------------------`,
        ],
        {
          sep: "\n",
        }
      )
    )
  },
})
