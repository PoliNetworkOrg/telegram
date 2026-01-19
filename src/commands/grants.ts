import type { ConversationMenuContext } from "@grammyjs/conversations"
import type { User } from "grammy/types"
import z from "zod"
import { api } from "@/backend"
import type { ConversationContext } from "@/lib/managed-commands"
import { logger } from "@/logger"
import { modules } from "@/modules"
import { duration } from "@/utils/duration"
import { fmt, fmtUser } from "@/utils/format"
import { getTelegramId } from "@/utils/telegram-id"
import { numberOrString } from "@/utils/types"
import { wait } from "@/utils/wait"
import { _commandsBase } from "./_base"

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
})

const timeFormat = new Intl.DateTimeFormat(undefined, {
  timeStyle: "short",
  hour12: false,
})

const datetimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
})

const getDateWithDelta = (date: Date, deltaDay: number) => {
  const newDate = new Date(date.getTime())
  newDate.setDate(newDate.getDate() + deltaDay)
  return newDate
}

const mainMsg = (user: User, startTime: Date, endTime: Date, duration: string, reason?: string) =>
  fmt(
    ({ n, b, u }) => [
      b`🔐 Grant Special Permissions`,
      n`${b`Target:`} ${fmtUser(user)}`,
      n`${b`Start Time:`} ${datetimeFormat.format(startTime)}`,
      n`${b`End Time:`} ${datetimeFormat.format(endTime)} (${duration})`,
      reason ? n`${b`Reason:`} ${reason}` : undefined,
      endTime.getTime() < Date.now()
        ? b`\n${u`INVALID:`} END datetime is in the past, change start date or duration.`
        : undefined,
    ],
    { sep: "\n" }
  )

const askDurationMsg = fmt(({ n, b }) => [b`How long should the special grant last?`, n`${duration.formatDesc}`], {
  sep: "\n",
})

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
    try {
      const userId: number | null = await conversation.external(async () =>
        typeof args.username === "string" ? await getTelegramId(args.username.replaceAll("@", "")) : args.username
      )

      if (userId === null) {
        await context.reply(fmt(({ n }) => n`Not a valid userId or username not in our cache`))
        return
      }

      const dbUser = await conversation.external(() => api.tg.users.get.query({ userId }))
      if (!dbUser || dbUser.error) {
        await context.reply(fmt(({ n }) => n`This user is not in our cache, we cannot proceed.`))
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

      const today = new Date(await conversation.now())
      const startDate = new Date(await conversation.now())
      let grantDuration = duration.zod.parse("2h")
      const endDate = () => new Date(startDate.getTime() + grantDuration.secondsFromNow * 1000)
      const baseMsg = () => mainMsg(target, startDate, endDate(), grantDuration.raw, args.reason)

      async function changeDuration(ctx: ConversationMenuContext<ConversationContext<"private">>, durationStr: string) {
        grantDuration = duration.zod.parse(durationStr)
        ctx.editMessageText(baseMsg(), { reply_markup: ctx.msg?.reply_markup })
        ctx.menu.nav("grants-main")
      }

      async function changeStartDate(ctx: ConversationMenuContext<ConversationContext<"private">>, delta: number) {
        startDate.setDate(today.getDate() + delta)
        ctx.editMessageText(
          fmt(({ skip, b }) => [skip`${baseMsg()}`, b`🕓 Changing start TIME`], { sep: "\n\n" }),
          { reply_markup: ctx.msg?.reply_markup }
        )
        ctx.menu.nav("grants-start-time")
      }

      async function changeStartTime(
        ctx: ConversationMenuContext<ConversationContext<"private">>,
        hour: number,
        minutes: number
      ) {
        // TODO: check timezone match between bot and user
        startDate.setHours(hour)
        startDate.setMinutes(minutes)
        ctx.editMessageText(baseMsg(), { reply_markup: ctx.msg?.reply_markup })
        ctx.menu.update()
        ctx.menu.nav("grants-main")
      }

      const backToMain = conversation.menu("grants-back-to-main", { parent: "grants-main" }).back("◀️ Back", (ctx) =>
        ctx.editMessageText(
          fmt(({ skip }) => [skip`${baseMsg()}`], { sep: "\n" }),
          { reply_markup: ctx.msg?.reply_markup }
        )
      )

      const durationMenu = conversation
        .menu("grants-duration", { parent: "grants-main" })
        .text("30m", (ctx) => changeDuration(ctx, "30m"))
        .text("2h", (ctx) => changeDuration(ctx, "2h"))
        .text("6h", (ctx) => changeDuration(ctx, "6h"))
        .text("1d", (ctx) => changeDuration(ctx, "1d"))
        .row()
        .text("✍️ Custom", async (ctx) => {
          ctx.menu.nav("grants-back-to-main")
          await ctx.editMessageText(
            fmt(({ skip }) => [skip`${baseMsg()}`, skip`${askDurationMsg}`], { sep: "\n\n" }),
            { reply_markup: backToMain }
          )
          let text: string
          do {
            const res = await conversation.waitFor(":text")
            res.deleteMessage()
            text = res.msg.text
          } while (!duration.zod.safeParse(text).success)

          await changeDuration(ctx, text)
        })
        .row()
        .back("◀️ Back")

      const _startTimeMenu = conversation
        .menu("grants-start-time", { parent: "grants-main" })
        .text(
          () => `Now: ${timeFormat.format(new Date())}`,
          (ctx) => changeStartTime(ctx, new Date().getHours(), new Date().getMinutes())
        )
        .row()
        .text("8:00", (ctx) => changeStartTime(ctx, 8, 0))
        .text("9:00", (ctx) => changeStartTime(ctx, 9, 0))
        .text("10:00", (ctx) => changeStartTime(ctx, 10, 0))
        .text("11:00", (ctx) => changeStartTime(ctx, 11, 0))
        .text("12:00", (ctx) => changeStartTime(ctx, 12, 0))
        .row()
        .text("13:00", (ctx) => changeStartTime(ctx, 13, 0))
        .text("14:00", (ctx) => changeStartTime(ctx, 14, 0))
        .text("15:00", (ctx) => changeStartTime(ctx, 15, 0))
        .text("16:00", (ctx) => changeStartTime(ctx, 16, 0))
        .text("17:00", (ctx) => changeStartTime(ctx, 17, 0))
        .row()
        .text("18:00", (ctx) => changeStartTime(ctx, 18, 0))
        .text("19:00", (ctx) => changeStartTime(ctx, 19, 0))
        .text("20:00", (ctx) => changeStartTime(ctx, 20, 0))
        .text("21:00", (ctx) => changeStartTime(ctx, 21, 0))
        .text("22:00", (ctx) => changeStartTime(ctx, 22, 0))
        .row()
        .back(
          () => `⚪️ Keep current time ${timeFormat.format(startDate)}`,
          (ctx) => ctx.editMessageText(baseMsg(), { reply_markup: ctx.msg?.reply_markup })
        )

      const startDateMenu = conversation
        .menu("grants-start-date", { parent: "grants-main" })
        .text(
          () => `Today ${dateFormat.format(today)}`,
          (ctx) => changeStartDate(ctx, 0)
        )
        .row()
        .text(dateFormat.format(getDateWithDelta(today, 1)), (ctx) => changeStartDate(ctx, 1))
        .text(dateFormat.format(getDateWithDelta(today, 2)), (ctx) => changeStartDate(ctx, 2))
        .text(dateFormat.format(getDateWithDelta(today, 3)), (ctx) => changeStartDate(ctx, 3))
        .row()
        .text(dateFormat.format(getDateWithDelta(today, 4)), (ctx) => changeStartDate(ctx, 4))
        .text(dateFormat.format(getDateWithDelta(today, 5)), (ctx) => changeStartDate(ctx, 5))
        .text(dateFormat.format(getDateWithDelta(today, 6)), (ctx) => changeStartDate(ctx, 6))
        .text(dateFormat.format(getDateWithDelta(today, 7)), (ctx) => changeStartDate(ctx, 7))
        .row()
        .back("◀️ Back", (ctx) => ctx.editMessageText(baseMsg(), { reply_markup: ctx.msg?.reply_markup }))

      const mainMenu = conversation
        .menu("grants-main")
        .text("✅ Confirm", async (ctx) => {
          await api.tg.grants.create.mutate({
            userId: target.id,
            adderId: context.from.id,
            reason: args.reason,
            since: startDate,
            until: endDate(),
          })

          await ctx.editMessageText(
            fmt(({ b, skip }) => [skip`${baseMsg()}`, b`✅ Special Permissions Granted`], { sep: "\n\n" })
          )

          await modules.get("tgLogger").grants({
            action: "CREATE",
            target,
            by: context.from,
            since: startDate,
            reason: args.reason,
            duration: grantDuration,
          })

          ctx.menu.close()
          await conversation.halt()
        })
        .row()
        .submenu("📆 Change Start Date", startDateMenu, (ctx) =>
          ctx.editMessageText(
            fmt(({ skip, b }) => [skip`${baseMsg()}`, b`📆 Changing start DATE`], { sep: "\n\n" }),
            { reply_markup: ctx.msg?.reply_markup }
          )
        )
        .submenu("⏱️ Change Duration", durationMenu, (ctx) =>
          ctx.editMessageText(
            fmt(({ skip, b }) => [skip`${baseMsg()}`, b`⏱️ Changing grant DURATION`], { sep: "\n\n" }),
            { reply_markup: ctx.msg?.reply_markup }
          )
        )
        .row()
        .text("❌ Cancel", async (ctx) => {
          await ctx.editMessageText(fmt(({ b, skip }) => [skip`${baseMsg()}`, b`❌ Grant Cancelled`], { sep: "\n\n" }))
          ctx.menu.close()
          await conversation.halt()
          await wait(3000)
          await ctx.deleteMessage()
        })

      const msg = await context.reply(baseMsg(), { reply_markup: mainMenu })
      await conversation.waitUntil(() => false, { maxMilliseconds: 60 * 60 * 1000 })
      await msg.delete()
    } catch (err) {
      logger.error({ err }, "Error in grant command")
      await context.deleteMessage()
      await conversation.halt()
    }
  },
})
