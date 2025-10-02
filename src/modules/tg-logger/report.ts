import type { Context } from "grammy"
import type { Message, User } from "grammy/types"
import { type CallbackCtx, MenuGenerator } from "@/lib/menu"
import { duration } from "@/utils/duration"
import { fmt, fmtChat, fmtDate, fmtUser } from "@/utils/format"
import { modules } from ".."

export type Report = {
  message: Message & { from: User }
  reporter: User
}

/**
 * Generate the initial text for a user report notification.
 *
 * @param report - The report data including message and reporter.
 * @param invite_link - An "optional" chat invite link to format the chat as link.
 * @returns A formatted string describing the report.
 */
export const getReportText = (report: Report, invite_link: string | undefined) =>
  fmt(
    ({ n, b }) => [
      b`⚠️ User Report`,
      n`${b`Group:`} ${fmtChat(report.message.chat, invite_link)}`,
      n`${b`Target:`} ${fmtUser(report.message.from)}`,
      n`${b`Reporter:`} ${fmtUser(report.reporter)}`,
    ],
    { sep: "\n" }
  )

/**
 * Edit an existing report message to mark it as resolved.
 * Updates the original message and appends resolution details and removes the menu.
 *
 * @typeParam C - The bot context type (extends grammy Context).
 *
 * @param report - {@link Report}
 * @param ctx - The callback context from the menu action.
 * @param actionText - A short description of the action taken, appended to the message.
 *
 * @returns A promise that resolves when the message has been edited.
 */
async function editReportMessage<C extends Context>(report: Report, ctx: CallbackCtx<C>, actionText: string) {
  const { invite_link } = await ctx.api.getChat(report.message.chat.id)
  const reportText = getReportText(report, invite_link)

  if (!ctx.msg) return
  await ctx.editMessageText(
    fmt(
      ({ b, n, skip }) => [
        skip`${reportText}`,
        n`--------------------------------`,
        n`✅ Resolved by ${fmtUser(ctx.from)}`,
        n`${b`Action:`} ${actionText}`,
        n`${b`Date:`} ${fmtDate(new Date())}`,
      ],
      { sep: "\n" }
    ),

    { reply_markup: undefined, link_preview_options: { is_disabled: true } }
  )
}

/**
 * Interactive menu for handling user reports.
 *
 * Provides buttons to ignore, delete the message,
 * kick, ban, or (future) ban all reported user.
 *
 * @param report - {@link Report}
 */
export const reportMenu = MenuGenerator.getInstance<Context>().create<Report>("report-command", [
  [
    {
      text: "✅ Ignore",
      cb: async ({ data, ctx }) => {
        await editReportMessage(data, ctx, "✅ Ignore")
        return null
      },
    },
    {
      text: "🗑 Del",
      cb: async ({ data, ctx }) => {
        await ctx.api.deleteMessage(data.message.chat.id, data.message.message_id)
        await editReportMessage(data, ctx, "🗑 Delete")
        return null
      },
    },
  ],
  [
    {
      text: "👢 Kick",
      cb: async ({ data, ctx }) => {
        await ctx.api.deleteMessage(data.message.chat.id, data.message.message_id)
        await ctx.api.banChatMember(data.message.chat.id, data.message.from.id, {
          // kick = ban for 1 minute, kick is not a thing in Telegram
          until_date: Math.floor(Date.now() / 1000) + duration.values.m,
        })
        await editReportMessage(data, ctx, "👢 Kick")
        return null
      },
    },
    {
      text: "🚫 Ban",
      cb: async ({ data, ctx }) => {
        await ctx.api.deleteMessage(data.message.chat.id, data.message.message_id)
        await ctx.api.banChatMember(data.message.chat.id, data.message.from.id)
        await editReportMessage(data, ctx, "🚫 Ban")
        return null
      },
    },
  ],
  [
    {
      text: "🚨 Start BAN ALL 🚨",
      cb: async ({ data, ctx }) => {
        modules
          .get("tgLogger")
          .banAll(
            data.message.from,
            ctx.from,
            "BAN",
            `Started after report by ${data.reporter.username ?? data.reporter.id}`
          )
        await editReportMessage(data, ctx, "🚨 Start BAN ALL")
        return null
      },
    },
  ],
])
