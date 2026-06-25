import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import { numberOrString, type Role } from "@/utils/types"
import { getOverloadUser, resolveUser } from "@/utils/users"
import { api } from "@/backend"

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
    reply: "optional",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      const userOverload = await getOverloadUser(context, repliedTo, args.reasonOrUser, args.reason)
      if (userOverload.isErr()) {
        void ephemeral(
          context.reply(
            repliedTo
              ? fmt(({ n }) => n`There was an error`)
              : fmt(({ n }) => n`Target user not found, please try replying to their message`)
          )
        )
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
          await context.reply(fmt(({ n }) => n`There was an error: ${error}`))
          return
        }
      } catch (error) {
        logger.error({ error }, "Failed to warn user")
        await context.reply(fmt(({ n }) => n`There was an error: ${String(error)}`))
        return
      }

      // Modified to contextually match warning logic
      await context.reply(
        fmt(({ b, n, i }) => [
          b`⚠️ User has been warned!`, 
          n`${b`Target:`} ${user.username ? `@${user.username}` : user.first_name}`,
          ...(reason ? [n`${b`Reason:`} ${i`${reason}`}`] : [])
        ], {
          sep: "\n",
        })
      )
    }
  })
.createCommand({
    trigger: "unwarn",
    args: [{ key: "warnId", type: "number", description: "Warning ID to remove (use /warns to get the ID)" }],
    description: "Remove a warning by its ID",
    scope: "both",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context }) => {
      const warnId = Number(args.warnId)

      try {
        await api.tg.warnings.deleteById.mutate({
          id: warnId
        })

        await context.reply(
          fmt(({ b, n }) => [
            b`✅ Warning removed!`, 
            n`Warning with ID ${b`#${warnId}`} has been lifted.`
          ], {
            sep: "\n",
          })
        )
      } catch (error) {
        logger.error({ warnId, error }, "Failed to delete warning")
        await context.reply(fmt(({ n }) => n`There was an error: ${String(error)}`))
      }
    },
  })
  .createCommand({
    trigger: "warns",
    description: "Get the warnings of a user",
    scope: "both",
    args: [{ key: "username", type: numberOrString, description: "Username (or user id) to get the warnings of" }],
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context }) => {

      const user = await resolveUser(args.username, context)
      if (!user) return

      try {
        const warns = await api.tg.warnings.getByTarget.query({
          targetId: user.id,
        })

        if (warns.length === 0) {
          return void await context.reply(`${user.username || user.first_name} has clean records (0 warnings).`)
        }
        await context.reply(
          fmt(({ b, i }) => [
            b`⚠️ Warning history for @${user.username || user.first_name}:`,
            `Total Warnings: ${warns.length}`,
            "",
            ...warns.map((warn, index) => {
              const date = new Date(warn.createdAt).toLocaleDateString()
              const status = warn.isExpired ? "🟢 [Expired]" : warn.deletedAt ? "🗑️ [Removed]" : "🔴 [Active]"
              const groupName = warn.group?.title || `Group ID: ${warn.groupId}`
              const adminName = warn.admin?.firstName ? `@${warn.admin.username || warn.admin.firstName}` : `ID: ${warn.adminId}`
              const reason = warn.reason ? i`${warn.reason}` : "No reason provided"

              return [
                `${index + 1}. ${status} — ${date}`,
                `   👥 ${b`Group:`} ${groupName}`,
                `   👮‍♂️ ${b`Admin:`} ${adminName}`,
                `   📝 ${b`Reason:`} ${reason}`,
                ""
              ].join("\n")
            })
          ], {
            sep: "\n",
          })
        )
      } catch (error) {
        logger.error({ error }, "Failed to fetch warnings")
        await context.reply(fmt(({ n }) => n`There was an error: ${String(error)}`))
      }
    },
})

