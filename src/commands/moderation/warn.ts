import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import { numberOrString, tgnumber, type MaybePromise, type PartialMessage, type Role } from "@/utils/types"
import { getOverloadUser, resolveUser } from "@/utils/users"
import { api } from "@/backend"


export type Warning = {
  id: number;
  targetId: number;
  adminId: number;
  groupId: number;
  reason: string | null;
  isExpired: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  group: {
    title: string;
    inviteLink: string | null;
  } | null;
  admin: {
    id: number;
    firstName: string;
    lastName?: string;
    username?: string;
    isBot: boolean;
    langCode?: string;
  } | null;
  target: {
    id: number;
    firstName: string;
    lastName?: string;
    username?: string;
    isBot: boolean;
    langCode?: string;
  } | null;
};

async function ephemeralInGroup(ctx: { chat: { type: string } }, message: MaybePromise<PartialMessage>) {
  if (ctx.chat.type === "private") {
    await message
  } else {
    void ephemeral(message)
  }
}

export const warn = new CommandsCollection<Role>("Warning")
  .createCommand({
    trigger: "warn",
    args: [
      {
        key: "reasonOrUser",
        optional: true,
        description:
          "If the message is a reply, this argument is the reason. Otherwise, it's the username or user id of the user to warn",
        type: numberOrString,
      },
      {
        key: "reason",
        optional: true,
        description: "Optional reason to warn the user",
      },
    ],
    description: "Warn a user from a group",
    scope: "both",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      const userOverload = await getOverloadUser(context, repliedTo ?? null, args.reasonOrUser, args.reason)
      if (userOverload.isErr()) {
        await ephemeralInGroup(context, context.reply(
          repliedTo
            ? fmt(({ n }) => n`There was an error`)
            : fmt(({ n }) => n`Target user not found, please try replying to their message`)
        ))
        logger.error({ args, repliedTo }, `WARN: ${userOverload.error}`)
        return
      }

      const { user, reason } = userOverload.value

      try {
        const { error } = await api.tg.warnings.create.mutate({
          targetId: user.id,
          adminId: context.from.id,
          groupId: context.chat.id,
          reason
        })

        if (error) {
          await ephemeralInGroup(context, context.reply(fmt(({ n }) => n`There was an error: ${error}`)))
          return
        }
      } catch (error) {
        logger.error({ error }, "Failed to warn user")
        await ephemeralInGroup(context, context.reply(fmt(({ n }) => n`There was an error: ${String(error)}`)))
        return
      }

      const extraLines: string[] = []

      if (context.chat.type === "group" || context.chat.type === "supergroup") {
        try {
          const [groupCount] = await api.tg.warnings.getActiveCountInGroup.query({
            targetId: user.id,
            groupId: context.chat.id,
          })
          if (groupCount.count >= 3) {
            const kickRes = await Moderation.kick(user, context.chat, context.from, [], "Auto-kick: 3 warnings in this group")
            if (kickRes.isOk()) {
              extraLines.push("👢 Auto-kicked (3 warnings in this group)")
            }
          }
        } catch (error) {
          logger.error({ error, targetId: user.id, groupId: context.chat.id }, "Auto-kick check failed after warning")
        }
      }

      try {
        const [totalCount] = await api.tg.warnings.getTotalActiveCount.query({
          targetId: user.id,
        })
        if (totalCount.count >= 4) {
          await modules.get("tgLogger").banAll(user, context.from, "BAN", "Auto-ban all: 4 total warnings")
          extraLines.push("🚫 Auto-ban all initiated (4 total warnings)")
        }
      } catch (error) {
        logger.error({ error, targetId: user.id }, "Auto-ban all check failed after warning")
      }

      await ephemeralInGroup(context, context.reply(
        fmt(({ b, n, i }) => [
          b`⚠️ User has been warned!`,
          n`${b`Target:`} ${user.username ? `@${user.username}` : user.first_name}`,
          ...(reason ? [n`${b`Reason:`} ${i`${reason}`}`] : []),
          ...(extraLines.length > 0 ? ["", ...extraLines.map(l => n`${l}`)] : []),
        ], {
          sep: "\n",
        })
      ))
    }
  })
.createCommand({
    trigger: "unwarn",
    args: [{ key: "warnId", type: tgnumber, description: "Warning ID to remove (use /warns to get the ID)" }],
    description: "Remove a warning by its ID",
    scope: "both",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context }) => {
      const warnId = Number(args.warnId)

      if (Number.isNaN(warnId)) {
        await ephemeralInGroup(context, context.reply(fmt(({ n }) => n`Invalid Warning ID. Use /warns to get the correct numeric ID.`)))
        return
      }

      try {
        const res = await api.tg.warnings.deleteById.mutate({
          id: warnId
        })

        if (res?.deleted === false) {
          await ephemeralInGroup(context, context.reply(
            fmt(({ n }) => n`That warning was already removed, expired or doesn't exist.`)
          ))
          return
        }

        await ephemeralInGroup(context, context.reply(
          fmt(({ b, n }) => [
            b`✅ Warning removed!`, 
            n`Warning with ID ${b`#${warnId}`} has been lifted.`
          ], {
            sep: "\n",
          })
        ))
      } catch (error) {
        logger.error({ warnId, error }, "Failed to delete warning")
        await ephemeralInGroup(context, context.reply(fmt(({ n }) => n`There was an error: ${String(error)}`)))
      }
    },
  })
  .createCommand({
    trigger: "warns",
    description: "Get the warnings of a user",
    scope: "private",
    args: [{ key: "username", type: numberOrString, description: "Username (or user id) to get the warnings of" }],
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
    },
    handler: async ({ args, context }) => {

      const user = await resolveUser(args.username, context)
      if (!user) return

      try {
        const warns: Warning[] = await api.tg.warnings.getByTarget.query({
          targetId: user.id,
        })

        if (warns.length === 0) {
          return void await context.reply(
            fmt(({ n }) => n`${user.username || user.first_name} has clean records (0 warnings).`)
          )
        }

        await context.reply(
          fmt(({ b, n, i, code }) => {
            const elements = [
              b`⚠️ Warning history for @${user.username || user.first_name}:`,
              `Total Warnings: ${warns.length}`,
              "",
            ];

            warns.forEach((warn, index) => {
              const date = new Date(warn.createdAt).toLocaleDateString();
              const status = warn.isExpired ? "🟢 [Expired]" : warn.deletedAt ? "🗑️ [Removed]" : "🔴 [Active]";
              
              const warningId = warn.id
              const groupName = warn.group?.title || `Group ID: ${warn.groupId}`;
              const adminName = warn.admin?.firstName 
                ? `@${warn.admin.username || warn.admin.firstName}` 
                : `ID: ${warn.adminId}`;
              
              elements.push(
                `${index + 1}. ${status} - ${date}`,
                n`   🆔 ${b`Warning ID:`} ${code`${warningId}`}`,
                n`   👥 ${b`Group:`} ${groupName}`,
                n`   👮‍♂️ ${b`Admin:`} ${adminName}`,
                n`   📝 ${b`Reason:`} ${warn.reason ? i`${warn.reason}` : "No reason provided"}`
              )

              if (index < warns.length - 1) {
                elements.push("");
              }
            });

            return elements;
          }, {
            sep: "\n",
          })
        )
      } catch (error) {
        logger.error({ error }, "Failed to fetch warnings")
        await context.reply(fmt(({ n }) => n`There was an error: ${String(error)}`))
      }
    },
})

