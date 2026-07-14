import { CommandsCollection } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { Moderation } from "@/modules/moderation"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import { numberOrString, tgnumber, type MaybePromise, type PartialMessage, type Role } from "@/utils/types"
import { getOverloadUser, resolveUser } from "@/utils/users"
import { api } from "@/backend"


/**
 * Shape of a warning record returned by the backend's `getByTarget` query.
 * Includes the warning metadata plus joined group/admin/target info.
 */
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

/**
 * Sends a message that auto-deletes after a short delay in groups,
 * but awaits it (persistent) in private chats where ephemeral isn't supported.
 */
async function ephemeralInGroup(ctx: { chat: { type: string } }, message: MaybePromise<PartialMessage>) {
  if (ctx.chat.type === "private") {
    await message
  } else {
    void ephemeral(message)
  }
}

export const warn = new CommandsCollection<Role>("Warning")
  /**
   * /warn - Creates a warning for a user and triggers automatic penalties:
   *         - 3 active warnings in the same group → auto-kick
   *         - 4 active warnings across all groups → auto-ban-all
   *
   * Scope is "both" so that high-privilege roles (owner, direttivo) can warn
   * even from DMs. Group admins are only allowed inside their own group via
   * the `allowGroupAdmins` permission flag.
   */
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
    description: "Warn a user in this group",
    scope: "both",
    permissions: {
      allowedRoles: ["owner", "direttivo"],
      excludedRoles: ["creator"],
      allowGroupAdmins: true,
    },
    handler: async ({ args, context, repliedTo }) => {
      // In DMs the command is only available to owner/direttivo; group admins
      // get filtered out here before any API calls or side effects happen.
      if (context.chat.type !== "group" && context.chat.type !== "supergroup") {
        const { roles } = await api.tg.permissions.getRoles.query({ userId: context.from.id })
        const ALLOWED_ROLES: Role[] = ["owner", "direttivo"]
        if (!roles?.some((r: Role) => ALLOWED_ROLES.includes(r))) return
      }
      // Resolve the target user - by reply, username, or user ID.
      // getOverloadUser handles all three cases and sends its own error reply
      // when the user cannot be found (via resolveUser). We skip our own reply
      // on SILENT_ERROR to avoid double-replying.
      const userOverload = await getOverloadUser(context, repliedTo ?? null, args.reasonOrUser, args.reason)
      if (userOverload.isErr()) {
        if (userOverload.error !== "SILENT_ERROR") {
          await ephemeralInGroup(context, context.reply(
            repliedTo
              ? fmt(({ n }) => n`There was an error`)
              : fmt(({ n }) => n`Target user not found, please try replying to their message`)
          ))
        }
        logger.error({ args, repliedTo }, `WARN: ${userOverload.error}`)
        return
      }

      const { user, reason } = userOverload.value

      // Persist the warning in the database.
      // groupId is always set to the current chat so the backend can later
      // count active warnings per-group or globally.
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

      // --- AUTO-KICK (group-level threshold) ---
      // Only runs inside groups/supergroups. In DMs there is no group to kick
      // from and context.chat.id would be a private chat ID, so we skip entirely.
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

      // --- AUTO-BAN-ALL (global threshold) ---
      // Runs unconditionally (both DMs and groups) because the ban-all affects
      // every group, not just the current one.
      try {
        const [totalCount] = await api.tg.warnings.getTotalActiveCount.query({
          targetId: user.id,
        })
        
        if (totalCount.count >= 4) {

          // Before issuing a network-wide ban, check that the target does not
          // hold bypass roles (president, owner, direttivo). This mirrors the
          // same guard in /ban_all so protected accounts cannot be auto-banned.
          const BYPASS_ROLES: Role[] = ["president", "owner", "direttivo"]

          const { roles } = await api.tg.permissions.getRoles.query({ userId: user.id })

          if (!roles?.some((r: Role) => BYPASS_ROLES.includes(r))) {
            await modules.get("tgLogger").banAll(user, context.from, "BAN", "Auto-ban all: 4 total warnings")
            extraLines.push("🚫 Auto-ban all initiated (4 total warnings)")
          } else {
            logger.warn({ targetId: user.id }, "Auto-ban all skipped: user has bypass roles")
          }

        }
      } catch (error) {
        logger.error({ error, targetId: user.id }, "Auto-ban all check failed after warning")
      }

      // Send the success reply with any auto-penalty notices appended.
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
  /**
   * /unwarn - Soft-deletes a warning by its numeric ID.
   *
   * In groups, the groupId is passed to the backend so that only warnings
   * belonging to that group can be removed (prevents cross-group deletion by
   * group admins). In DMs, groupId is omitted since high-privilege roles
   * (owner, direttivo) are allowed to remove any warning globally.
   */
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

      // In DMs, require explicit role check because allowGroupAdmins in the
      // permissions block doesn't apply outside a group context.
      if (context.chat.type === "private") {
        const { roles } = await api.tg.permissions.getRoles.query({ userId: context.from.id })
        const ALLOWED_ROLES: Role[] = ["owner", "direttivo"]
        if (!roles?.some((r: Role) => ALLOWED_ROLES.includes(r))) {
          await context.reply(fmt(({ n }) => n`This command can only be used in a group.`))
          return
        }
      }

      try {
        // Pass groupId only when inside a group so the backend verifies the
        // warning belongs to that chat. Omit it in DMs to allow global deletion.
        const res = await api.tg.warnings.deleteById.mutate({
          id: warnId,
          groupId: context.chat.type !== "private" ? context.chat.id : undefined,
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
  /**
   * /warns - Lists all warnings (active, expired, removed) for a given user.
   *
   * Only available in private chats to avoid leaking warning data inside
   * groups. Messages are chunked at 4000 characters to stay under Telegram's
   * 4096-character per-message limit.
   */
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

        // Chunk at 4000 chars to leave room for Telegram's overhead.
        const MAX_LENGTH = 4000
        const messageParts: string[] = []
        let currentPart = fmt(({ b, n }) => [
          b`⚠️ Warning history for @${user.username || user.first_name}:`,
          n`Total Warnings: ${warns.length}`,
          "",
        ], { sep: "\n" })

        for (const warn of warns) {
          const date = new Date(warn.createdAt).toLocaleDateString();
          const status = warn.isExpired ? "🟢 [Expired]" : warn.deletedAt ? "🗑️ [Removed]" : "🔴 [Active]";
          const groupName = warn.group?.title || `Group ID: ${warn.groupId}`;
          const adminName = warn.admin?.firstName 
            ? `@${warn.admin.username || warn.admin.firstName}` 
            : `ID: ${warn.adminId}`;

          const entryStr = fmt(({ b, n, i, code }) => [
            "",
            `${warns.indexOf(warn) + 1}. ${status} - ${date}`,
            n`   🆔 ${b`Warning ID:`} ${code`${warn.id}`}`,
            n`   👥 ${b`Group:`} ${groupName}`,
            n`   👮‍♂️ ${b`Admin:`} ${adminName}`,
            n`   📝 ${b`Reason:`} ${warn.reason ? i`${warn.reason}` : "No reason provided"}`,
          ], { sep: "\n" })

          if ((currentPart + entryStr).length > MAX_LENGTH) {
            messageParts.push(currentPart)
            currentPart = entryStr
          } else {
            currentPart += entryStr
          }
        }

        if (currentPart) messageParts.push(currentPart)

        for (const part of messageParts) {
          await context.reply(part)
        }
      } catch (error) {
        logger.error({ error }, "Failed to fetch warnings")
        await context.reply(fmt(({ n }) => n`There was an error: ${String(error)}`))
      }
    },
})
