import { api } from "@/backend"
import { logger } from "@/logger"
import { fmt } from "@/utils/format"

import { _commandsBase } from "./_base"

_commandsBase.createCommand({
  trigger: "link",
  scope: "private",
  description: "Verify the login code for the admin dashboard",
  args: [{ key: "code", description: "The code to verify", optional: true }],
  handler: async ({ context, args, conversation }) => {
    let { code } = args
    if (context.from === undefined) return
    if (context.from.username === undefined) {
      await context.reply(fmt(() => `You need to set a username to use this command`))
      return
    }

    if (code === undefined) {
      let question = await context.reply(
        fmt(() => `Please send me the code you received in the admin dashboard`),
        { reply_markup: { force_reply: true } }
      )
      let { message } = await conversation.waitFor("message")
      while (!/^\d{6}$/.test(message.text)) {
        await question.delete()
        await message.delete()
        question = await context.reply(
          fmt(() => `Invalid code, please paste the 6 digit code directly`),
          { reply_markup: { force_reply: true } }
        )
        message = (await conversation.waitFor("message")).message
      }
      code = message.text
      void question.delete()
      void message.delete()
    }

    const res = await api.tg.link.link.query({
      code,
      telegramId: context.from.id,
      telegramUsername: context.from.username,
    })
    if (res.error) {
      logger.error(res.error)
      await context.reply(fmt(() => `Invalid code or your username does not match.`))
      return
    }
    if (res.success) {
      await context.reply(
        fmt(({ b }) => [b`Code verified!`, `This telegram account is now linked in the admin dashboard.`], {
          sep: "\n",
        })
      )
    }
  },
})
