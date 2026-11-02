import type { Context } from "grammy"
import type { BotCommand } from "grammy/types"
import { fmt } from "@/utils/format"
import type { AccessControl, AnyCommand } from "./command"
import { commandTriggers, isAllowedInGroups } from "./command"

/**
 * Whether a user may run a command in groups:
 * - `yes`: in every group where the command is enabled
 * - `if_group_admin`: only in groups where the user is a group admin, which the bot cannot know in advance
 * - `no`: in no group
 */
export type GroupAvailability = "yes" | "if_group_admin" | "no"

/** Where a user may run a command, as far as the bot can tell from a private chat */
export type CommandAvailability = {
  private: boolean
  groups: GroupAvailability
}

export type HelpSection<T> = { collection: string; entries: T[] }

export const HELP_TRIGGER = "help"
export const HELP_BOT_COMMAND: BotCommand = { command: HELP_TRIGGER, description: "Show the commands you can use" }

const MARK = {
  private: "👤",
  groups: "👥",
  everywhere: "🌍",
  groupAdmin: "🛡️",
} as const

type AnyCmd = AnyCommand<Context, AccessControl>

export function isAvailable(availability: CommandAvailability): boolean {
  return availability.private || availability.groups !== "no"
}

function formatTriggers(cmd: AnyCmd): string {
  return commandTriggers(cmd)
    .map((t) => `/${t}`)
    .join(" | ")
}

function isLimitedToSomeGroups(cmd: AnyCmd): boolean {
  return isAllowedInGroups(cmd) && cmd.permissions?.allowedGroupsId !== undefined
}

function availabilityMark(availability: CommandAvailability): string {
  const where = !availability.private ? MARK.groups : availability.groups === "no" ? MARK.private : MARK.everywhere
  return availability.groups === "if_group_admin" ? `${where}${MARK.groupAdmin}` : where
}

/** A sentence telling the user where they can run the command */
function describeAvailability(cmd: AnyCmd, availability: CommandAvailability): string {
  const parts: string[] = []
  if (availability.private) parts.push("in private chat with the bot")
  if (availability.groups === "yes") parts.push("in groups")
  if (availability.groups === "if_group_admin") parts.push("in groups where you are an admin")
  const where = parts.join(" and ")
  const limited = availability.groups !== "no" && isLimitedToSomeGroups(cmd) ? " (only some groups)" : ""
  return `${where.charAt(0).toUpperCase()}${where.slice(1)}${limited}`
}

function formatCommandShort(cmd: AnyCmd, mark?: string): string {
  const args = cmd.args ?? []
  return fmt(({ i, n }) => [
    formatTriggers(cmd),
    ...args.map(({ key, optional }) => (optional ? i` [${key}]` : i` <${key}>`)),
    n`\n\t${mark ? `${mark} ` : ""}${cmd.description ?? "No description"}`,
  ])
}

/**
 * Creates a formatted message to display the usage of a command to the user
 * @param cmd The command to print usage for
 * @param availableTo Where the user can run the command
 * @returns A markdown formatted string representing the usage of the command
 */
function formatCommandUsage(cmd: AnyCmd, availableTo: string): string {
  const args = cmd.args ?? []
  const scope = cmd.scope === "private" ? "Private Chat" : cmd.scope === "group" ? "Groups" : "Groups and Private Chat"

  return fmt(({ n, b, i }) => [
    formatTriggers(cmd),
    ...args.map(({ key, optional }) => (optional ? n`[${i`${key}`}]` : n`<${i`${key}`}>`)),
    i`\nDesc:`,
    b`${cmd.description ?? "No description"}`,
    i`\nScope:`,
    b`${scope}`,
    i`\nAvailable to you:`,
    b`${availableTo}`,
    ...(cmd.reply ? [i`\nCall while replying to a message:`, b`${cmd.reply.toUpperCase()}`] : []),
    args.length ? i`\nArgs:` : ``,
    ...args.flatMap(({ key, description }) => [`\n-`, i`${key}:`, description ?? "No description"]),
  ])
}

export function formatUsageFromPrivate(cmd: AnyCmd, availability: CommandAvailability): string {
  return formatCommandUsage(cmd, describeAvailability(cmd, availability))
}

export function formatUsageInGroup(cmd: AnyCmd): string {
  return formatCommandUsage(cmd, "In this group")
}

function formatSections<T>(
  sections: HelpSection<T>[],
  header: (collection: string) => string,
  format: (entry: T) => string
): string[] {
  return sections.flatMap(({ collection, entries }) => [
    ...(collection === "default" ? [] : [header(collection)]),
    ...entries.map(format),
  ])
}

/** The /help message in private chat: every command the user can run, in private chat or in groups */
export function formatHelpFromPrivate(sections: HelpSection<{ cmd: AnyCmd; availability: CommandAvailability }>[]) {
  const all = sections.flatMap((s) => s.entries.map((e) => e.availability))
  const legend = [
    all.some((a) => a.private && a.groups === "no") ? `${MARK.private} private chat only` : null,
    all.some((a) => !a.private) ? `${MARK.groups} groups only` : null,
    all.some((a) => a.private && a.groups !== "no") ? `${MARK.everywhere} private chat and groups` : null,
  ].filter((l) => l !== null)
  const anyGroupAdmin = all.some((a) => a.groups === "if_group_admin")

  return fmt(
    ({ b, i, n, u, code, skip }) => [
      b`Commands you can use:`,
      ...formatSections(
        sections,
        (collection) => u`${b`\n${collection}:`}`,
        ({ cmd, availability }) => skip`${formatCommandShort(cmd, availabilityMark(availability))}`
      ),
      "",
      ...(legend.length ? [i`${legend.join(", ")}`] : []),
      ...(anyGroupAdmin ? [i`${MARK.groupAdmin} only in groups where you are an admin`] : []),
      n`Type ${code`/help <command>`} for more details on a specific command.`,
    ],
    { sep: "\n" }
  )
}

/** The /help message in a group: the commands the user can run in that group */
export function formatHelpInGroup(sections: HelpSection<AnyCmd>[]) {
  return fmt(
    ({ b, n, u, code, skip }) => [
      b`Commands you can use in this group:`,
      ...formatSections(
        sections,
        (collection) => u`${b`\n${collection}:`}`,
        (cmd) => skip`${formatCommandShort(cmd)}`
      ),
      "",
      n`Type ${code`/help <command>`} for more details on a specific command, or send ${code`/help`} in private chat with the bot to see all of your commands.`,
    ],
    { sep: "\n" }
  )
}

/** The entries of the Telegram commands menu for a list of commands, aliases included, followed by /help */
export function toMenu(cmds: AnyCmd[]): BotCommand[] {
  return [
    ...cmds.flatMap((cmd) =>
      commandTriggers(cmd).map((command) => ({
        command,
        // Telegram limits descriptions to 256 characters
        description: (cmd.description ?? "No description").slice(0, 256),
      }))
    ),
    HELP_BOT_COMMAND,
  ]
}
