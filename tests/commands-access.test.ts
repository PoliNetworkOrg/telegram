import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply } from "@grammyjs/parse-mode"
import type { Bot } from "grammy"
import type { Chat, User } from "grammy/types"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { PERMISSION, type Permission } from "@/access"
import { commands } from "@/commands"
import { authorizeCommand } from "@/commands/access"
import { commandTriggers } from "@/lib/managed-commands/command"
import { telemetry } from "@/modules/telemetry/middleware"
import type { Context } from "@/utils/types"
import { type Exchange, FakeTelegram } from "./harness/telegram"

/**
 * Runs the bot's real commands, with their real access control and hooks, against a fake Telegram and a fake IdP:
 * what /help and the commands menu show must be exactly what each user can run.
 */

const idp = vi.hoisted(() => ({
  permissions: new Map<number, readonly string[]>(),
  resolves: 0,
  offline: false,
}))

vi.mock("@/backend", () => {
  const backend = {
    tg: {
      access: {
        resolve: {
          query: async ({ telegramIds }: { telegramIds: number[] }) => {
            idp.resolves++
            if (idp.offline) throw new Error("IdP offline")
            return Object.fromEntries(
              telegramIds.map((id) => [
                String(id),
                { sub: `user-${id}`, permissions: [...(idp.permissions.get(id) ?? [])], grant: null },
              ])
            )
          },
        },
      },
    },
  }
  return { backendFor: () => backend, backendAs: () => backend, serviceBackend: backend }
})
vi.mock("@/env", () => ({
  env: { NODE_ENV: "development", BOT_TOKEN: "x", BACKEND_URL: "localhost", INFLUXDB_URL: "http://localhost" },
}))
// offline Redis: storage adapters fall back to memory
vi.mock("@/redis", async () => {
  const { EventEmitter } = await import("node:events")
  return { redis: Object.assign(new EventEmitter(), { isOpen: false, isReady: false }) }
})
vi.mock("@/modules", () => {
  const noop: object = new Proxy({}, { get: () => async () => {} })
  return { modules: { get: () => noop, shared: { api: { deleteMessage: async () => true } } } }
})
vi.mock("@/logger", () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} }
  return { logger }
})

type Outcome = "ran" | "denied" | "wrong_scope"

function outcome(exchange: Exchange): Outcome {
  const texts = exchange.replies.map((r) => r.text)
  if (texts.some((t) => t.includes("You are not allowed to execute this command"))) return "denied"
  if (texts.some((t) => t.includes("This command must be run in"))) return "wrong_scope"
  return "ran"
}

const tg = new FakeTelegram()
let bot: Bot<Context>
const group = tg.group("Network group")
const otherGroup = tg.group("Another group")

beforeAll(async () => {
  bot = await tg.createBot<Context>((b) => {
    b.use(hydrate())
    b.use(hydrateReply)
    b.use(telemetry())
    b.use(commands)
  })
})

beforeEach(() => {
  idp.permissions.clear()
  idp.offline = false
})

function withPermissions(name: string, permissions: Permission[]): User {
  const user = tg.user(name)
  idp.permissions.set(user.id, permissions)
  return user
}

/** Every trigger of every command, aliases included */
const triggers = commands.getCommands().flatMap((cmd) => commandTriggers(cmd))

async function run(user: User, trigger: string, chat?: Chat): Promise<Outcome> {
  return outcome(await tg.send(bot, user, `/${trigger}`, { chat }))
}

function parsePrivateHelp(text: string): Map<string, string> {
  const lines = text.split("\n")
  const entries = new Map<string, string>()
  for (const [i, line] of lines.entries()) {
    const match = /^\/(\w+)/.exec(line)
    if (!match) continue
    const triggersOnLine = [...line.matchAll(/\/(\w+)/g)].map((m) => m[1])
    const mark = /^\t(\S+) /.exec(lines[i + 1] ?? "")?.[1] ?? ""
    for (const t of triggersOnLine) entries.set(t, mark)
  }
  return entries
}

function parseGroupHelp(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("/"))
    .flatMap((line) => [...line.matchAll(/\/(\w+)/g)].map((m) => m[1]))
    .filter((t) => t !== "help")
}

async function waitForMenu(user: User, chat: Chat | undefined, expected: string[]) {
  await vi.waitFor(() => {
    expect(
      tg
        .menuCommandsOf(user, chat)
        .filter((c) => c !== "help")
        .sort()
    ).toEqual([...expected].sort())
  })
}

describe("bot commands: /help and menus match what each user can run", () => {
  const profiles: [string, Permission[]][] = [
    ["no permissions", []],
    ["moderator", [PERMISSION.moderate]],
    ["global moderator", [PERMISSION.moderateGlobal]],
    ["message manager", [PERMISSION.messagesDelete, PERMISSION.messagesPin]],
    ["staff", [PERMISSION.auditRead, PERMISSION.usersRead, PERMISSION.groupsManage]],
    ["only trusted", [PERMISSION.trusted, PERMISSION.immune]],
    ["everything", Object.values(PERMISSION)],
  ]

  it.each(profiles)("%s", async (name, permissions) => {
    const user = withPermissions(name, permissions)

    const inPrivate = new Set<string>()
    const asMember = new Set<string>()
    const asAdmin = new Set<string>()
    for (const trigger of triggers) if ((await run(user, trigger)) === "ran") inPrivate.add(trigger)

    for (const admin of [false, true]) {
      if (admin) tg.setAdmin(group, user)
      else tg.removeAdmin(group, user)
      const here = admin ? asAdmin : asMember
      for (const trigger of triggers) if ((await run(user, trigger, group)) === "ran") here.add(trigger)

      const help = await tg.send(bot, user, "/help", { chat: group })
      expect(help.replies[0]?.ephemeralTo).toBe(user.id)
      expect(parseGroupHelp(help.reply).sort(), `group /help as ${admin ? "admin" : "member"}`).toEqual(
        [...here].sort()
      )
      await waitForMenu(user, group, [...here])
    }

    await tg.send(bot, user, "/help")
    await waitForMenu(user, undefined, [...inPrivate])

    const help = parsePrivateHelp((await tg.send(bot, user, "/help")).reply)
    for (const trigger of triggers) {
      const groups = asMember.has(trigger) ? "yes" : asAdmin.has(trigger) ? "admin" : "no"
      const expected =
        !inPrivate.has(trigger) && groups === "no"
          ? undefined
          : `${inPrivate.has(trigger) ? (groups === "no" ? "👤" : "🌍") : "👥"}${groups === "admin" ? "🛡️" : ""}`
      expect(help.get(trigger), `/${trigger} in private /help`).toBe(expected)
    }
  })
})

describe("bot commands: access", () => {
  it("shows a user without permissions the public commands and those open to group admins", async () => {
    const user = withPermissions("nobody", [])
    const help = parsePrivateHelp((await tg.send(bot, user, "/help")).reply)

    expect(help.get("start")).toBe("👤")
    expect(help.get("search")).toBe("🌍")
    expect(help.get("report")).toBe("👥")
    for (const trigger of ["ban", "tban", "unban", "kick", "mute", "tmute", "unmute", "del", "pin", "unpin"])
      expect(help.get(trigger), trigger).toBe("👥🛡️")
    for (const trigger of [
      "ban_all",
      "unban_all",
      "audit",
      "userid",
      "getroles",
      "updategroup",
      "regenerate_group_links",
    ])
      expect(help.has(trigger), trigger).toBe(false)
  })

  it("lets Telegram chat admins moderate only in their groups, and never grants global commands", async () => {
    const admin = withPermissions("chat admin", [])
    tg.setAdmin(group, admin)

    expect(await run(admin, "ban", group)).toBe("ran")
    expect(await run(admin, "ban", otherGroup)).toBe("denied")
    expect(await run(admin, "ban_all")).toBe("denied")
    expect(await run(admin, "audit")).toBe("denied")
  })

  it("looks up the user's IdP permissions once per update", async () => {
    const user = withPermissions("lookups", [PERMISSION.moderate])
    tg.setAdmin(group, user)

    idp.resolves = 0
    await tg.send(bot, user, "/help")
    expect(idp.resolves).toBe(1)

    idp.resolves = 0
    await tg.send(bot, user, "/help", { chat: group })
    // the forced menu refresh runs in the background on the same update
    await vi.waitFor(() => expect(tg.menuCommandsOf(user, group)).toContain("ban"))
    expect(idp.resolves).toBe(1)
  })

  it("denies and hides restricted commands while the IdP is unavailable, except for group admins", async () => {
    const user = withPermissions("offline", Object.values(PERMISSION))
    idp.offline = true

    expect(await run(user, "ban_all")).toBe("denied")
    expect(await run(user, "ban", otherGroup)).toBe("denied")
    const help = parsePrivateHelp((await tg.send(bot, user, "/help")).reply)
    expect(help.has("ban_all")).toBe(false)
    expect(help.get("ban")).toBe("👥🛡️")

    tg.setAdmin(otherGroup, user)
    expect(await run(user, "ban", otherGroup)).toBe("ran")
  })

  it("applies the group admin shortcut only to commands that allow it", async () => {
    const user = withPermissions("admin elsewhere", [])
    const context = { from: user, chat: group } as unknown as Parameters<typeof authorizeCommand>[0]["context"]
    const isGroupAdmin = vi.fn(async () => true)
    const check = async () => ({ allowed: true, via: "unrestricted" }) as const
    const command = (allowTelegramChatAdmins?: boolean) => ({
      trigger: "x",
      scope: "group" as const,
      permissions: { requiredPermissions: [PERMISSION.moderate], allowTelegramChatAdmins },
      handler: async () => {},
    })

    expect(await authorizeCommand({ context, command: command(), isGroupAdmin, check })).toEqual({
      allowed: false,
      basis: null,
    })
    expect(isGroupAdmin).not.toHaveBeenCalled()
    expect(await authorizeCommand({ context, command: command(true), isGroupAdmin, check })).toEqual({
      allowed: true,
      basis: "telegram_chat_admin",
    })
  })
})
