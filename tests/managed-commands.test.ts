import type { Bot, Context } from "grammy"
import type { Chat, User } from "grammy/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  type AccessControl,
  type CommandScopedContext,
  ManagedCommands,
  type ManagedCommandsFlavor,
  type ManagedCommandsHooks,
} from "@/lib/managed-commands"
import { FakeTelegram } from "./harness/telegram"

vi.mock("@/modules", () => ({ modules: {} }))

type Ctx = ManagedCommandsFlavor<Context>

/** Mirrors the shape of the bot's own access control: permissions to hold, or the group admin shortcut */
interface TestAccess extends AccessControl {
  permissions: { required?: string[]; groupAdminsToo?: boolean }
  authorization: { allowed: boolean; basis: "permission" | "group_admin" | null }
}

type Scope = "private" | "group" | "both"
type Spec = {
  trigger: string
  scope: Scope
  collection?: string
  permissions?: TestAccess["permissions"] & { allowedGroupsId?: number[]; excludedGroupsId?: number[] }
}

function setup(
  options: {
    hooks?: ManagedCommandsHooks<Ctx, CommandScopedContext, TestAccess>
    refreshAfterMs?: number
    /** Leave out the commands limited by group allow/deny lists */
    withoutGroupLists?: boolean
  } = {}
) {
  const tg = new FakeTelegram()
  const users = {
    nobody: tg.user("Nobody"),
    secretHolder: tg.user("SecretHolder"),
    mod: tg.user("Mod"),
    admin: tg.user("Admin"),
    pinner: tg.user("Pinner"),
  }
  const groups = {
    allowed: tg.group("Allowed"),
    excluded: tg.group("Excluded"),
    plain: tg.group("Plain"),
  }

  const idp = new Map<number, string[]>([
    [users.secretHolder.id, ["secret"]],
    [users.mod.id, ["mod"]],
    [users.pinner.id, ["pin"]],
  ])
  const failingLookups = new Set<number>()
  let lookups = 0

  const allSpecs: Spec[] = [
    { trigger: "start", scope: "private" },
    { trigger: "search", scope: "both" },
    { trigger: "report", scope: "group" },
    { trigger: "secret", scope: "private", collection: "Management", permissions: { required: ["secret"] } },
    { trigger: "audit", scope: "both", collection: "Management", permissions: { required: ["secret"] } },
    {
      trigger: "ban",
      scope: "group",
      collection: "Moderation",
      permissions: { required: ["mod"], groupAdminsToo: true },
    },
    {
      trigger: "warn",
      scope: "both",
      collection: "Moderation",
      permissions: { required: ["mod"], groupAdminsToo: true },
    },
    { trigger: "local", scope: "group", permissions: { allowedGroupsId: [groups.allowed.id] } },
    { trigger: "notexcluded", scope: "group", permissions: { excludedGroupsId: [groups.excluded.id] } },
    {
      trigger: "nowhere",
      scope: "group",
      permissions: { allowedGroupsId: [groups.excluded.id], excludedGroupsId: [groups.excluded.id] },
    },
    {
      trigger: "pin",
      scope: "group",
      collection: "Moderation",
      permissions: { required: ["pin"], groupAdminsToo: true, allowedGroupsId: [groups.allowed.id] },
    },
  ]

  const specs = options.withoutGroupLists
    ? allSpecs.filter((s) => !s.permissions?.allowedGroupsId && !s.permissions?.excludedGroupsId)
    : allSpecs

  const ran: { trigger: string; userId: number; chatId: number; authorization: TestAccess["authorization"] }[] = []
  const commands = new ManagedCommands<Ctx, CommandScopedContext, TestAccess>({
    hooks: options.hooks ?? {},
    menus: { blocking: true, refreshAfterMs: options.refreshAfterMs ?? 0 },
    authorize: async ({ context, command, isGroupAdmin }) => {
      const required = command.permissions?.required ?? []
      if (!required.length) return { allowed: true, basis: null }
      const userId = context.from?.id ?? 0
      lookups++
      const held = failingLookups.has(userId) ? null : (idp.get(userId) ?? [])
      if (held && required.every((p) => held.includes(p))) return { allowed: true, basis: "permission" }
      if (command.permissions?.groupAdminsToo && (await isGroupAdmin())) return { allowed: true, basis: "group_admin" }
      return { allowed: false, basis: null }
    },
  })
  for (const spec of specs) {
    commands.createCommand(
      {
        trigger: spec.trigger,
        scope: spec.scope,
        description: `desc-${spec.trigger}`,
        permissions: spec.permissions,
        handler: async ({ context, authorization }) => {
          ran.push({ trigger: spec.trigger, userId: context.from.id, chatId: context.chat.id, authorization })
        },
      },
      spec.collection
    )
  }

  return {
    tg,
    users,
    groups,
    specs,
    idp,
    failingLookups,
    ran,
    lookups: () => lookups,
    bot: tg.createBot<Ctx>((bot) => bot.use(commands)),
  }
}

/** Parses the private /help into trigger → availability mark */
function parsePrivateHelp(text: string): Map<string, string> {
  const lines = text.split("\n")
  const entries = new Map<string, string>()
  for (const [i, line] of lines.entries()) {
    const match = /^\/(\w+)/.exec(line)
    if (!match) continue
    const mark = /^\t(\S+) desc-/.exec(lines[i + 1] ?? "")
    entries.set(match[1], mark?.[1] ?? "")
  }
  return entries
}

function parseGroupHelp(text: string): string[] {
  return text
    .split("\n")
    .map((line) => /^\/(\w+)/.exec(line)?.[1])
    .filter((t): t is string => t !== undefined && t !== "help")
}

async function runs(env: ReturnType<typeof setup>, bot: Bot<Ctx>, user: User, trigger: string, chat?: Chat) {
  const before = env.ran.length
  await env.tg.send(bot, user, `/${trigger}`, { chat })
  return env.ran.length > before
}

describe("ManagedCommands: /help and menus tell exactly what can run", () => {
  it("agrees with execution for every user, chat, admin status and command", async () => {
    const env = setup()
    const { tg, users, groups, specs } = env
    const bot = await env.bot
    const allGroups = Object.values(groups)

    for (const user of Object.values(users)) {
      const truth = new Map<string, { private: boolean; asMember: boolean; asAdmin: boolean }>()
      for (const { trigger } of specs) truth.set(trigger, { private: false, asMember: false, asAdmin: false })

      // ground truth: actually run every command, in private and in each group, as a member and as an admin
      for (const { trigger } of specs) {
        const t = truth.get(trigger)
        if (!t) throw new Error("unreachable")
        t.private = await runs(env, bot, user, trigger)
      }
      for (const asAdmin of [false, true]) {
        for (const group of allGroups) {
          if (asAdmin) tg.setAdmin(group, user)
          else tg.removeAdmin(group, user)

          const inGroup = new Set<string>()
          for (const { trigger } of specs) if (await runs(env, bot, user, trigger, group)) inGroup.add(trigger)
          for (const trigger of inGroup) {
            const t = truth.get(trigger)
            if (t && asAdmin) t.asAdmin = true
            if (t && !asAdmin) t.asMember = true
          }

          // group /help and the menu in the group list exactly what runs there
          const help = await tg.send(bot, user, "/help", { chat: group })
          expect(help.replies).toHaveLength(1)
          expect(help.replies[0].ephemeralTo).toBe(user.id)
          const label = `${user.first_name} in ${group.title} (${asAdmin ? "admin" : "member"})`
          expect(parseGroupHelp(help.reply).sort(), label).toEqual([...inGroup].sort())
          expect(
            tg
              .menuCommandsOf(user, group)
              .filter((c) => c !== "help")
              .sort(),
            label
          ).toEqual([...inGroup].sort())
        }
      }

      // the private menu lists what runs in private
      await tg.send(bot, user, "hello")
      expect(
        tg
          .menuCommandsOf(user)
          .filter((c) => c !== "help")
          .sort(),
        `${user.first_name} private menu`
      ).toEqual(
        specs
          .map((s) => s.trigger)
          .filter((t) => truth.get(t)?.private)
          .sort()
      )

      // the private /help lists what runs somewhere, marking what needs group admin rights
      const help = parsePrivateHelp((await tg.send(bot, user, "/help")).reply)
      for (const { trigger } of specs) {
        const t = truth.get(trigger)
        if (!t) throw new Error("unreachable")
        const groupsMark = t.asMember ? "yes" : t.asAdmin ? "admin" : "no"
        const expected =
          !t.private && groupsMark === "no"
            ? undefined
            : `${t.private ? (groupsMark === "no" ? "👤" : "🌍") : "👥"}${groupsMark === "admin" ? "🛡️" : ""}`
        expect(help.get(trigger), `${user.first_name}: /${trigger} in private /help`).toBe(expected)
      }
    }
  })

  it("lists for an ordinary user the commands they could run as a group admin", async () => {
    const env = setup()
    const bot = await env.bot
    const help = await env.tg.send(bot, env.users.nobody, "/help")
    const entries = parsePrivateHelp(help.reply)

    expect(Object.fromEntries(entries)).toEqual({
      start: "👤",
      search: "🌍",
      report: "👥",
      ban: "👥🛡️",
      warn: "👥🛡️",
      local: "👥",
      notexcluded: "👥",
      pin: "👥🛡️",
    })
    expect(help.reply).toContain("🛡️ only in groups where you are an admin")
    expect(help.reply).toContain("Moderation:")
    expect(help.reply).not.toContain("Management:")
  })

  it("never applies the group admin shortcut outside of groups, even if the admin check says yes", async () => {
    const overrideGroupAdminCheck = vi.fn(async () => true)
    const env = setup({ hooks: { overrideGroupAdminCheck } })
    const bot = await env.bot

    expect(await runs(env, bot, env.users.nobody, "warn")).toBe(false)
    expect(overrideGroupAdminCheck).not.toHaveBeenCalled()

    expect(await runs(env, bot, env.users.nobody, "warn", env.groups.plain)).toBe(true)
    expect(env.ran.at(-1)?.authorization).toEqual({ allowed: true, basis: "group_admin" })
    expect(overrideGroupAdminCheck).toHaveBeenCalledWith(env.users.nobody.id, env.groups.plain.id, expect.anything())
  })

  it("passes the decision that allowed the command to the handler", async () => {
    const env = setup()
    const bot = await env.bot
    env.tg.setAdmin(env.groups.plain, env.users.admin)

    await runs(env, bot, env.users.mod, "ban", env.groups.plain)
    await runs(env, bot, env.users.admin, "ban", env.groups.plain)
    await runs(env, bot, env.users.nobody, "search", env.groups.plain)

    expect(env.ran.map((r) => [r.trigger, r.userId, r.authorization.basis])).toEqual([
      ["ban", env.users.mod.id, "permission"],
      ["ban", env.users.admin.id, "group_admin"],
      ["search", env.users.nobody.id, null],
    ])
  })

  it("asks Telegram about the user's admin status at most once per update", async () => {
    const env = setup()
    const bot = await env.bot
    const help = await env.tg.send(bot, env.users.nobody, "/help", { chat: env.groups.allowed })
    expect(help.called("getChatMember")).toHaveLength(1)

    const ban = await env.tg.send(bot, env.users.nobody, "/ban", { chat: env.groups.plain })
    expect(ban.called("getChatMember")).toHaveLength(1)
  })

  it("hides commands whose permissions cannot be checked, and denies running them", async () => {
    const env = setup()
    const bot = await env.bot
    env.failingLookups.add(env.users.mod.id)

    expect(await runs(env, bot, env.users.mod, "ban", env.groups.plain)).toBe(false)
    expect(parsePrivateHelp((await env.tg.send(bot, env.users.mod, "/help")).reply).get("ban")).toBe("👥🛡️")
  })

  it("shows the usage only of commands the user can run", async () => {
    const env = setup()
    const bot = await env.bot

    expect((await env.tg.send(bot, env.users.nobody, "/help secret")).reply).toContain("Command not found")
    expect((await env.tg.send(bot, env.users.nobody, "/help doesnotexist")).reply).toContain("Command not found")

    const secret = (await env.tg.send(bot, env.users.secretHolder, "/help /secret")).reply
    expect(secret).toContain("desc-secret")
    expect(secret).toContain("Available to you: In private chat with the bot")

    const ban = (await env.tg.send(bot, env.users.nobody, "/help ban")).reply
    expect(ban).toContain("Available to you: In groups where you are an admin")

    const pin = (await env.tg.send(bot, env.users.pinner, "/help pin")).reply
    expect(pin).toContain("Available to you: In groups (only some groups)")

    const inGroup = await env.tg.send(bot, env.users.nobody, "/help ban", { chat: env.groups.plain })
    expect(inGroup.reply).toContain("Command not found")
    env.tg.setAdmin(env.groups.plain, env.users.nobody)
    const asAdmin = await env.tg.send(bot, env.users.nobody, "/help ban", { chat: env.groups.plain })
    expect(asAdmin.reply).toContain("Available to you: In this group")
    expect(asAdmin.replies[0].ephemeralTo).toBe(env.users.nobody.id)
    expect(asAdmin.called("deleteMessage")).toHaveLength(1)
  })
})

describe("ManagedCommands: commands menus", () => {
  let env: ReturnType<typeof setup>
  let bot: Bot<Ctx>

  beforeEach(async () => {
    env = setup({ refreshAfterMs: 60_000, withoutGroupLists: true })
    bot = await env.bot
  })

  it("sets default menus with the commands anyone can run", async () => {
    const first = await env.tg.send(bot, env.users.nobody, "hello")
    expect(first.called("setMyCommands").map((c) => (c.payload.scope as { type: string }).type)).toEqual([
      "all_private_chats",
      "all_group_chats",
    ])
    expect(env.tg.menuCommandsOf(env.users.nobody)).toEqual(["start", "search", "help"])
    expect(env.tg.menuCommandsOf(env.users.nobody, env.groups.plain)).toEqual(["search", "report", "help"])

    // only once
    const second = await env.tg.send(bot, env.users.mod, "hello", { chat: env.groups.plain })
    expect(second.called("setMyCommands").map((c) => (c.payload.scope as { type: string }).type)).toEqual([
      "chat_member",
    ])
  })

  it("gives users who can run more commands their own menu, only where it differs", async () => {
    const inPrivate = await env.tg.send(bot, env.users.nobody, "hello")
    expect(inPrivate.called("setMyCommands")).toHaveLength(2) // the defaults only
    const inGroup = await env.tg.send(bot, env.users.nobody, "hello", { chat: env.groups.plain })
    expect(inGroup.called("getChatMember")).toHaveLength(1)
    expect(inGroup.called("setMyCommands")).toEqual([])
    expect(inGroup.called("deleteMyCommands")).toEqual([])

    await env.tg.send(bot, env.users.mod, "hello", { chat: env.groups.plain })
    expect(env.tg.menuCommandsOf(env.users.mod, env.groups.plain)).toEqual(["search", "report", "ban", "warn", "help"])
    await env.tg.send(bot, env.users.mod, "hello")
    expect(env.tg.menuCommandsOf(env.users.mod)).toEqual(["start", "search", "warn", "help"])
    // other chats are untouched
    expect(env.tg.menuCommandsOf(env.users.mod, env.groups.allowed)).toEqual(["search", "report", "help"])
  })

  it("does not recompute a menu until it is due, unless the user asks for /help", async () => {
    env.tg.setAdmin(env.groups.plain, env.users.admin)
    const first = await env.tg.send(bot, env.users.admin, "hello", { chat: env.groups.plain })
    expect(first.called("getChatMember")).toHaveLength(1)
    expect(env.tg.menuCommandsOf(env.users.admin, env.groups.plain)).toContain("ban")

    env.tg.removeAdmin(env.groups.plain, env.users.admin)
    const second = await env.tg.send(bot, env.users.admin, "hello", { chat: env.groups.plain })
    expect(second.calls).toEqual([])
    expect(env.tg.menuCommandsOf(env.users.admin, env.groups.plain)).toContain("ban")

    // /help refreshes the menu, back to the default one
    const help = await env.tg.send(bot, env.users.admin, "/help", { chat: env.groups.plain })
    expect(help.called("deleteMyCommands")).toHaveLength(1)
    expect(env.tg.menuCommandsOf(env.users.admin, env.groups.plain)).toEqual(["search", "report", "help"])
  })

  it("picks up permission changes once the menu is due again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      await env.tg.send(bot, env.users.nobody, "hello")
      expect(env.tg.menuCommandsOf(env.users.nobody)).not.toContain("secret")

      env.idp.set(env.users.nobody.id, ["secret"])
      vi.setSystemTime(Date.now() + 61_000)
      await env.tg.send(bot, env.users.nobody, "hello")
      expect(env.tg.menuCommandsOf(env.users.nobody)).toEqual(["start", "search", "secret", "audit", "help"])

      env.idp.delete(env.users.nobody.id)
      vi.setSystemTime(Date.now() + 61_000)
      await env.tg.send(bot, env.users.nobody, "hello")
      expect(env.tg.menuCommandsOf(env.users.nobody)).toEqual(["start", "search", "help"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("retries the default menus if setting them fails", async () => {
    let fail = true
    env.tg.on("setMyCommands", () => {
      if (fail) throw new Error("network down")
      return true
    })
    await env.tg.send(bot, env.users.nobody, "hello").catch(() => {})
    fail = false
    const retry = await env.tg.send(bot, env.users.nobody, "hello")
    expect(retry.called("setMyCommands").length).toBeGreaterThanOrEqual(2)
  })
})

describe("ManagedCommands: registration", () => {
  it("reserves the /help trigger", () => {
    const commands = new ManagedCommands()
    expect(() => commands.createCommand({ trigger: "help", handler: async () => {} })).toThrow(/already registered/)
  })

  it("still reports commands run in the wrong chat type", async () => {
    const wrongScope = vi.fn(async () => {})
    const env = setup({ hooks: { wrongScope } })
    const bot = await env.bot
    await env.tg.send(bot, env.users.secretHolder, "/secret", { chat: env.groups.plain })
    await env.tg.send(bot, env.users.mod, "/ban")
    expect(wrongScope).toHaveBeenCalledTimes(2)
    expect(env.ran).toEqual([])
  })

  it("the default authorization reports group admins through the built-in check", async () => {
    const tg = new FakeTelegram()
    const ran: unknown[] = []
    const commands = new ManagedCommands({ menus: false }).createCommand({
      trigger: "kick",
      scope: "group",
      permissions: { allowGroupAdmins: true },
      handler: async ({ authorization }) => {
        ran.push(authorization)
      },
    })
    const bot = await tg.createBot<Ctx>((b) => b.use(commands))
    const group = tg.group("Group")
    const admin = tg.user("Admin")
    const member = tg.user("Member")
    tg.setAdmin(group, admin)

    await tg.send(bot, admin, "/kick", { chat: group })
    const memberRun = await tg.send(bot, member, "/kick", { chat: group })
    expect(ran).toEqual([
      { allowed: true, via: "group_admin" },
      { allowed: true, via: "unrestricted" },
    ])
    expect(memberRun.called("setMyCommands")).toEqual([])
  })
})
