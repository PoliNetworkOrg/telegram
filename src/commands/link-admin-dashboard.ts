import { InlineKeyboard } from "grammy"

import { api } from "@/backend"
import { logger } from "@/logger"
import { fmt } from "@/utils/format"

import { _commandsBase } from "./_base"
import { wait } from "@/utils/wait"
import { ConversationMenuContext } from "@grammyjs/conversations"
import { ConversationContext } from "@/lib/managed-commands"
import { CommandConversation } from "@/lib/managed-commands/command"

const mainMsg = fmt(({ b, n, u }) => [b`🔗 Admin dashboard link`, b`\nStatus: ⏳ WAITING FOR CODE`], { sep: "\n" })

const warnMsg = fmt(
  ({ n, b, u }) => [
    b`🔗 Admin dashboard link`,
    b`\n⚠️ ${u`WARN`}: Proceed ONLY if you started the Link from the Admin Dashboard intentionally.`,
    b`\nWhat is this?`,
    `This is the procedure to link your telegram account (id and username) to your account on PoliNetwork's Admin Dashboard.`,
    `Once entered your username in the Admin Dashboard, it will give you a code; while you insert the code here, the link will be completed.`,
    b`\nWhy is needed?`,
    `For two reasons:`,
    `1. It allows us to verify that you have sufficient permissions to use the dashboard`,
    n`2. It allows you to perform ${b`Telegram actions`} from the Dashbord (like banning a user)`,
  ],
  { sep: "\n" }
)

async function cancel(
  conv: CommandConversation<"private">,
  ctx: ConversationMenuContext<ConversationContext<"private">>
) {
  await ctx.editMessageText(fmt(({ n, code }) => n`Linking procedure was canceled. Send ${code`/link`} to restart it.`))
  await wait(4000)
  await ctx.deleteMessage()
  ctx.menu.close()
  await conv.halt()
}

_commandsBase.createCommand({
  trigger: "link",
  scope: "private",
  description: "Verify the login code for the admin dashboard",
  handler: async ({ context, args, conversation }) => {
    await context.deleteMessage()
    // we need username
    if (context.from.username === undefined) {
      await context.reply(fmt(() => `You need to set a username to use this command`))
      return
    }

    const cancelMenu = conversation.menu().text("Cancel", (ctx) => cancel(conversation, ctx))
    const warnMenu = conversation
      .menu()
      .text("Proceed", async (ctx) => {
        await ctx.editMessageText(mainMsg, { reply_markup: cancelMenu })
      })
      .row()
      .text("Cancel", (ctx) => cancel(conversation, ctx))

    const msg = await context.reply(warnMsg, { reply_markup: warnMenu })
    let failed = false
    let codeMsg = await conversation.waitFor("message:text")
    while (!/^\d{6}$/.test(codeMsg.message.text)) {
      void codeMsg.deleteMessage()
      if (!failed) {
        // first time invalid
        await msg.editText(
          fmt(
            ({ b }) => [
              b`🔗 Admin dashboard link`,
              b`\nStatus: ⭕️ Invalid Code (must be a 6-digit number), send again`,
            ],
            { sep: "\n" }
          ),
          { reply_markup: cancelMenu, parse_mode: "MarkdownV2" }
        )
        failed = true
      }
      codeMsg = await conversation.waitFor("message:text")
    }

    const code = codeMsg.message.text
    await codeMsg.deleteMessage()
    await msg.editText(
      fmt(({ b }) => [b`🔗 Admin dashboard link`, b`\nStatus: 🔄 Verifying the code ${code}`], { sep: "\n" }),
      { parse_mode: "MarkdownV2" }
    )

    const res = await api.tg.link.link.query({
      code,
      telegramId: context.from.id,
      telegramUsername: context.from.username,
    })
    if (res.error) {
      logger.error(res.error)

      await msg.editText(
        fmt(
          ({ b }) => [
            b`🔗 Admin dashboard link`,
            b`\nStatus: 🔴 Invalid code or username mismatch`,
            `You need to send again the command to try again.`,
          ],
          { sep: "\n" }
        ),
        { parse_mode: "MarkdownV2" }
      )
    } else if (res.success) {
      await msg.editText(
        fmt(({ b }) => [b`🔗 Admin dashboard link`, b`\nStatus: ✅ LINKED SUCCESSFULLY`], { sep: "\n" }),
        { parse_mode: "MarkdownV2" }
      )
    }

    await wait(4000)
    await msg.delete()
  },
})
