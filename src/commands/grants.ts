import type { User } from "grammy/types"
import z from "zod"
import { api } from "@/backend"
import { duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString } from "@/utils/types"
import { wait } from "@/utils/wait"
import { _commandsBase } from "./_base"

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
})

const askStart = (user: User, reason?: string) =>
  fmt(
    ({ n, b }) => [
      b`🔐 Grant Special Permissions`,
      n`${b`Target:`} ${fmtUser(user)}`,
      reason ? n`${b`Reason:`} ${reason}\n` : "",
      b`When should the special grant start?`,
      `(Default: now)`,
    ],
    { sep: "\n" }
  )

const askDuration = (user: User, startTime: string, reason?: string) =>
  fmt(
    ({ n, b }) => [
      b`🔐 Grant Special Permissions`,
      n`${b`Target:`} ${fmtUser(user)}`,
      reason ? n`${b`Reason:`} ${reason}\n` : "",
      n`${b`Start Time:`} ${startTime}`,
      b`\nHow long should the special grant last?`,
      `(${duration.formatDesc} - Default: 2 hours)`,
    ],
    { sep: "\n" }
  )

const askConfirm = (user: User, startTime: string, endTime: string, duration: string, reason?: string) =>
  fmt(
    ({ n, b }) => [
      b`🔐 Grant Special Permissions`,
      n`${b`Target:`} ${fmtUser(user)}`,
      reason ? n`${b`Reason:`} ${reason}\n` : "",
      n`${b`Start Time:`} ${startTime}`,
      n`${b`End Time:`} ${endTime} (${duration})`,
      b`\nConfirm granting special permissions to this user?`,
    ],
    { sep: "\n" }
  )

const doneMsg = (user: User, startTime: string, endTime: string, duration: string, reason?: string) =>
  fmt(
    ({ n, b }) => [
      b`🔐 Grant Special Permissions`,
      b`✅ Special Permissions Granted`,
      n`${b`Target:`} ${fmtUser(user)}`,
      reason ? n`${b`Reason:`} ${reason}\n` : "",
      n`${b`Start Time:`} ${startTime}`,
      n`${b`End Time:`} ${endTime} (${duration})`,
    ],
    { sep: "\n" }
  )

const cancelMsg = (user: User) =>
  fmt(({ n, b }) => [b`🔐 Grant Special Permissions`, b`❌ Grant Cancelled`, n`${b`Target:`} ${fmtUser(user)}`], {
    sep: "\n",
  })

type GrantConversationState = "askStart" | "askDuration" | "askConfirm" | "done"
function previousState(current: GrantConversationState) {
  if (current === "askConfirm") return "askDuration"
  if (current === "askDuration") return "askStart"
  return current
}
function nextState(current: GrantConversationState) {
  if (current === "askStart") return "askDuration"
  if (current === "askDuration") return "askConfirm"
  return current
}

_commandsBase.createCommand({
  trigger: "grant",
  description: "Grant special permissions to a user allowing them to bypass the Auto-Moderation stack",
  scope: "private",
  permissions: {
    allowedRoles: ["direttivo"],
  },
  args: [
    {
      key: "username",
      type: numberOrString,
      description: "The username or the user id of the user you want to grant special permissions to",
    },
    {
      key: "reason",
      type: z.string(),
      description: "The reason why you are granting special permissions to the user",
      optional: true,
    },
  ],
  handler: async ({ args, context, conversation }) => {
    let state: GrantConversationState = "askStart"
    const userId: number | null = await conversation.external(async () =>
      typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username
    )

    if (userId === null) {
      await context.reply("Not a valid userId or username not in our cache")
      return
    }

    const dbUser = await conversation.external(() => api.tg.users.get.query({ userId }))
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

    const startDate = new Date(await conversation.now())
    let grantDuration = duration.zod.parse("2h")

    const messageString = () => {
      switch (state) {
        case "askStart":
          return askStart(target, args.reason)
        case "askDuration":
          return askDuration(target, dateFormat.format(startDate), args.reason)
        case "askConfirm": {
          const endDate = new Date(startDate.getTime() + grantDuration.secondsFromNow * 1000)
          return askConfirm(
            target,
            dateFormat.format(startDate),
            dateFormat.format(endDate),
            grantDuration.raw,
            args.reason
          )
        }
        case "done": {
          const endDate = new Date(startDate.getTime() + grantDuration.secondsFromNow * 1000)
          return doneMsg(
            target,
            dateFormat.format(startDate),
            dateFormat.format(endDate),
            grantDuration.raw,
            args.reason
          )
        }
      }
    }

    function menuForState(s: GrantConversationState) {
      if (s === "askStart") return firstMenu
      if (s === "askConfirm") return confirmMenu
      if (s === "done") return undefined
      return menu
    }

    async function updateToNewState(ctx: typeof context, newState: GrantConversationState) {
      state = newState
      await ctx.editMessageText(messageString(), { reply_markup: menuForState(state) })
      await conversation.rewind(checkpoint)
    }

    async function cancel(ctx: typeof context) {
      await ctx.editMessageText(cancelMsg(target))
    }

    const menu = conversation
      .menu()
      .text("◀️ Prev", (ctx) => updateToNewState(ctx, previousState(state)))
      .text("Next ▶️", (ctx) => updateToNewState(ctx, nextState(state)))
      .row()
      .text("Cancel", (ctx) => cancel(ctx))

    const firstMenu = conversation
      .menu()
      .text("Next ▶️", (ctx) => updateToNewState(ctx, "askDuration"))
      .row()
      .text("Cancel", (ctx) => cancel(ctx))

    const confirmMenu = conversation
      .menu()
      .text("Confirm ✅", (ctx) => updateToNewState(ctx, "done"))
      .row()
      .text("◀️ Prev", (ctx) => updateToNewState(ctx, "askDuration"))
      .row()
      .text("Cancel", (ctx) => cancel(ctx))

    await context.reply(askStart(target, args.reason), { reply_markup: firstMenu })

    const checkpoint = conversation.checkpoint()

    void conversation
      .waitUntil(() => state === "askStart")
      .andFor("message:text")
      .then(async (ctx) => {
        await ctx.deleteMessage()
        const response = ctx.message.text
        const parsedDate = Date.parse(response ?? "")
        if (!Number.isNaN(parsedDate)) {
          startDate.setTime(parsedDate)
          await updateToNewState(context, "askDuration")
        } else {
          void context
            .reply("Invalid date format, please try again. (e.g. 2024-12-31 14:00)")
            .then((m) => wait(10_000).then(() => m.delete()))
          await conversation.rewind(checkpoint)
        }
      })

    void conversation
      .waitUntil(() => state === "askDuration")
      .andFor("message:text")
      .then(async (ctx) => {
        await ctx.deleteMessage()
        const response = ctx.message.text
        const parsedDuration = duration.zod.safeParse(response ?? "")
        if (parsedDuration.success) {
          grantDuration = parsedDuration.data
          await updateToNewState(context, "askConfirm")
        } else {
          void context
            .reply(`Invalid duration format, please try again. ${duration.formatDesc}`)
            .then((m) => wait(10_000).then(() => m.delete()))
          await conversation.rewind(checkpoint)
        }
      })

    await conversation.waitUntil(() => state === "done")

    // do the thing
    const grantEndDate = new Date(startDate.getTime() + grantDuration.secondsFromNow * 1000)
    await api.tg.grants.create.mutate({
      userId: target.id,
      adderId: context.from.id,
      reason: args.reason,
      since: startDate,
      until: grantEndDate,
    })
  },
})
