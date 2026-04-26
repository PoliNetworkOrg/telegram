import { hydrate } from "@grammyjs/hydrate"
import { hydrateReply, parseMode } from "@grammyjs/parse-mode"
import { MemorySessionStorage } from "grammy"
import { beforeEach, describe, expect, it } from "vitest"
import { ManagedCommands, type ManagedCommandsFlavor } from "@/lib/managed-commands"
import {
  createDummyBot,
  generateCommandCall,
  generateGroupCommandCall,
  type OutgoingRequest,
  type ResultType,
} from "../common/dummy-bot"

let wasMissingPermissions = false
const { bot, outgoingRequests } = await createDummyBot<ManagedCommandsFlavor>()

type Role = "admin" | "mod" | "banned"

const commands = new ManagedCommands<Role>({
  adapter: new MemorySessionStorage(),
  getUserRoles: async (userId) => {
    if (userId === 1) return ["admin"]
    if (userId === 2) return ["mod"]
    if (userId === 3) return ["banned"]
    if (userId === 4) return ["admin", "banned"]
    return []
  },
  plugins: [
    async (ctx, next) => {
      ctx.api.config.use(async (_, method, payload) => {
        outgoingRequests.push({ method, payload })
        return { ok: true, result: true as ResultType }
      })
      await next()
    },
  ],
  hooks: {
    overrideGroupAdminCheck: async (userId) => {
      return userId === 1 || userId === 99
    },
    missingPermissions: async () => {
      wasMissingPermissions = true
    },
  },
})
  .createCommand({
    trigger: "public",
    handler: async ({ context }) => {
      await context.reply("Public command executed")
    },
  })
  .createCommand({
    trigger: "private",
    scope: "private",
    handler: async ({ context }) => {
      await context.reply("Private command executed")
    },
  })
  .createCommand({
    trigger: "group",
    scope: "group",
    permissions: {
      allowGroupAdmins: false,
    },
    handler: async ({ context }) => {
      await context.reply("Group command executed")
    },
  })
  .createCommand({
    trigger: "role_admin",
    permissions: {
      allowedRoles: ["admin"],
    },
    handler: async ({ context }) => {
      await context.reply("Role admin command executed")
    },
  })
  .createCommand({
    trigger: "role_mod",
    permissions: {
      allowedRoles: ["mod"],
    },
    handler: async ({ context }) => {
      await context.reply("Role mod command executed")
    },
  })
  .createCommand({
    trigger: "role_admin_or_mod",
    permissions: {
      allowedRoles: ["admin", "mod"],
    },
    handler: async ({ context }) => {
      await context.reply("Role admin or mod command executed")
    },
  })
  .createCommand({
    trigger: "excluded_banned",
    permissions: {
      excludedRoles: ["banned"],
    },
    handler: async ({ context }) => {
      await context.reply("Excluded banned command executed")
    },
  })
  .createCommand({
    trigger: "group_admin",
    scope: "group",
    permissions: {
      allowedRoles: [],
      allowGroupAdmins: true,
    },
    handler: async ({ context }) => {
      await context.reply("Group admin command executed")
    },
  })
  .createCommand({
    trigger: "group_allowed_only",
    scope: "group",
    permissions: {
      allowGroupAdmins: false,
      allowedGroupsId: [50],
    },
    handler: async ({ context }) => {
      await context.reply("Group allowed-only command executed")
    },
  })
  .createCommand({
    trigger: "group_excluded",
    scope: "group",
    permissions: {
      allowGroupAdmins: false,
      excludedGroupsId: [60],
    },
    handler: async ({ context }) => {
      await context.reply("Group excluded command executed")
    },
  })
  .createCommand({
    trigger: "group_allowed_and_excluded",
    scope: "group",
    permissions: {
      allowGroupAdmins: false,
      allowedGroupsId: [70],
      excludedGroupsId: [70],
    },
    handler: async ({ context }) => {
      await context.reply("Group allowed-and-excluded command executed")
    },
  })

bot.use(hydrate())
bot.use(hydrateReply)
bot.api.config.use(parseMode("MarkdownV2"))
bot.use(commands)

beforeEach(() => {
  outgoingRequests.length = 0
  wasMissingPermissions = false
})

function payloadText(request?: OutgoingRequest): string | undefined {
  if (!!request && "text" in request.payload) {
    return request.payload.text
  }
  return undefined
}

function sendMessages(): OutgoingRequest[] {
  return outgoingRequests.filter((request) => request.method === "sendMessage")
}

function lastSentText(): string | undefined {
  const request = sendMessages().at(-1)
  return payloadText(request)
}

function expectNoMessageWithText(text: string): void {
  expect(sendMessages().some((request) => payloadText(request) === text)).toBe(false)
}

function normalizeMarkdownEscapes(text?: string): string {
  return (text ?? "").replaceAll("\\_", "_")
}

function expectMissingPermissions(): void {
  expect(wasMissingPermissions).toBe(true)
  wasMissingPermissions = false
}

describe("ManagedCommands - Permissions", () => {
  it("executes command without permissions", async () => {
    await bot.handleUpdate(generateCommandCall("public"))
    expect(lastSentText()).toBe("Public command executed")
  })

  it("allows command when user has a required role", async () => {
    await bot.handleUpdate(generateCommandCall("role_admin", 1))
    expect(lastSentText()).toBe("Role admin command executed")
  })

  it("denies command when user misses required role", async () => {
    await bot.handleUpdate(generateCommandCall("role_admin", 2))
    expectNoMessageWithText("Role admin command executed")
    expectMissingPermissions()
  })

  it("allows command when at least one allowed role matches", async () => {
    await bot.handleUpdate(generateCommandCall("role_admin_or_mod", 2))
    expect(lastSentText()).toBe("Role admin or mod command executed")
  })

  it("denies command when all allowed roles are missing", async () => {
    await bot.handleUpdate(generateCommandCall("role_admin_or_mod"))
    expectNoMessageWithText("Role admin or mod command executed")
    expectMissingPermissions()
  })

  it("denies command when user has an excluded role", async () => {
    await bot.handleUpdate(generateCommandCall("excluded_banned", 3))
    expectNoMessageWithText("Excluded banned command executed")
    expectMissingPermissions()
  })

  it("denies command when excluded role is present with an allowed one", async () => {
    await bot.handleUpdate(generateCommandCall("excluded_banned", 4))
    expectNoMessageWithText("Excluded banned command executed")
    expectMissingPermissions()
  })

  it("allows group-admin command for group admins without external roles", async () => {
    await bot.handleUpdate(generateGroupCommandCall("group_admin", 99))
    expect(lastSentText()).toBe("Group admin command executed")
  })

  it("denies group-admin command for non-admin users without required roles", async () => {
    await bot.handleUpdate(generateGroupCommandCall("group_admin"))
    expectNoMessageWithText("Group admin command executed")
    expectMissingPermissions()
  })

  it("allows command only in explicitly allowed groups", async () => {
    await bot.handleUpdate(generateGroupCommandCall("group_allowed_only", 50))
    expect(lastSentText()).toBe("Group allowed-only command executed")
  })

  it("denies command outside explicitly allowed groups", async () => {
    await bot.handleUpdate(generateGroupCommandCall("group_allowed_only", 51))
    expectNoMessageWithText("Group allowed-only command executed")
    expectMissingPermissions()
  })

  it("denies command in excluded groups", async () => {
    await bot.handleUpdate(generateGroupCommandCall("group_excluded", 60))
    expectNoMessageWithText("Group excluded command executed")
    expectMissingPermissions()
  })

  it("allows command in non-excluded groups", async () => {
    await bot.handleUpdate(generateGroupCommandCall("group_excluded", 61))
    expect(lastSentText()).toBe("Group excluded command executed")
  })

  it("gives exclusion precedence when group is both allowed and excluded", async () => {
    await bot.handleUpdate(generateGroupCommandCall("group_allowed_and_excluded", 70))
    expectNoMessageWithText("Group allowed-and-excluded command executed")
    expectMissingPermissions()
  })

  it("shows only commands allowed by role in help for regular users", async () => {
    await bot.handleUpdate(generateCommandCall("help", 10))
    const text = normalizeMarkdownEscapes(lastSentText())
    expect(text).toContain("Available commands")
    expect(text).toContain("/public")
    expect(text).toContain("/private")
    expect(text).toContain("/group")
    expect(text).toContain("/excluded_banned")
    expect(text).toContain("/group_admin")
    expect(text).not.toContain("/role_admin")
    expect(text).not.toContain("/role_mod")
    expect(text).not.toContain("/role_admin_or_mod")
  })

  it("shows role-gated commands in help for admins", async () => {
    await bot.handleUpdate(generateCommandCall("help", 1))
    const text = normalizeMarkdownEscapes(lastSentText())
    expect(text).toContain("/role_admin")
    expect(text).toContain("/role_admin_or_mod")
    expect(text).not.toContain("/role_mod")
    expect(text).toContain("/excluded_banned")
  })

  it("hides excluded commands in help for excluded users", async () => {
    await bot.handleUpdate(generateCommandCall("help", 3))
    const text = normalizeMarkdownEscapes(lastSentText())
    expect(text).toContain("Available commands")
    expect(text).not.toContain("/excluded_banned")
  })

  it("hides group-restricted command in help when current group is not allowed", async () => {
    await bot.handleUpdate(generateGroupCommandCall("help", 51))
    const text = normalizeMarkdownEscapes(lastSentText())
    expect(text).toContain("Available commands")
    expect(text).not.toContain("/group_allowed_only")
  })

  it("shows group-restricted command in help when current group is allowed", async () => {
    await bot.handleUpdate(generateGroupCommandCall("help", 50))
    const text = normalizeMarkdownEscapes(lastSentText())
    expect(text).toContain("Available commands")
    expect(text).toContain("/group_allowed_only")
  })
})
