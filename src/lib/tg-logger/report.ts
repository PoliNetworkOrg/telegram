import type { Context } from "grammy"
import type { Message, User } from "grammy/types"
import { duration } from "@/utils/duration"
import { fmt, fmtChat, fmtDate, fmtUser } from "@/utils/format"
import { type CallbackCtx, MenuGenerator } from "../menu"

export type Report = {
  message: Message & { from: User }
  reporter: User
}

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

async function editReportMessage<C extends Context>(report: Report, ctx: CallbackCtx<C>, actionText: string) {
  const { invite_link } = await ctx.api.getChat(report.message.chat.id)
  const reportText = getReportText(report, invite_link)

  if (!ctx.msg) return
  await ctx.editMessageText(
    fmt(
      ({ b, n, skip }) => [
        skip`${reportText}`,
        n`--------------------------------`,
        n`✅ Resolved by ${fmtUser(report.reporter)}`,
        n`${b`Action:`} ${actionText}`,
        n`${b`Date:`} ${fmtDate(new Date())}`,
      ],
      { sep: "\n" }
    ),

    { reply_markup: undefined, link_preview_options: { is_disabled: true } }
  )
}

export const reportMenu = MenuGenerator.getInstance<Context>().create<Report>("report-command", [
  [
    {
      text: "✅ Ignore",
      cb: async ({ data, ctx }) => {
        await editReportMessage(data, ctx, "✅ Ignore")
      },
    },
    {
      text: "🗑 Del",
      cb: async ({ data, ctx }) => {
        await ctx.api.deleteMessage(data.message.chat.id, data.message.message_id)
        await editReportMessage(data, ctx, "🗑 Delete")
      },
    },
  ],
  [
    {
      text: "👢 Kick",
      cb: async ({ data, ctx }) => {
        await ctx.api.deleteMessage(data.message.chat.id, data.message.message_id)
        await ctx.api.banChatMember(data.message.chat.id, data.message.from.id, {
          until_date: Math.floor(Date.now() / 1000) + duration.values.m,
        })
        await editReportMessage(data, ctx, "👢 Kick")
      },
    },
    {
      text: "🚫 Ban",
      cb: async ({ data, ctx }) => {
        await ctx.api.deleteMessage(data.message.chat.id, data.message.message_id)
        await ctx.api.banChatMember(data.message.chat.id, data.message.from.id)
        await editReportMessage(data, ctx, "🚫 Ban")
      },
    },
  ],
  [
    {
      text: "🚨 Start BAN ALL 🚨",
      cb: async ({ data, ctx }) => {
        await editReportMessage(data, ctx, "🚨 Start BAN ALL (not implemented yet)")
        return "❌ Not implemented yet"
      },
    },
  ],
])
