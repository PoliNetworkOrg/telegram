import { CommandsCollection } from "@/lib/managed-commands"
import { MenuGenerator } from "@/lib/menu"
import { logger } from "@/logger"

const generateMenu = MenuGenerator.getInstance().create<{
  messageId: number
  chatId: number
}>("test-name", [
  [
    {
      text: "🗑 Delete + 🚫 Ban",
      cb: async ({ ctx, data }) => {
        await ctx.editMessageText(`${ctx.msg?.text ?? ""}\nBAN`, { reply_markup: ctx.msg?.reply_markup ?? undefined })
        logger.info({ data }, "TESTSTESTSTSTE")
        return { feedback: "Deleted + Banned" }
      },
    },
  ],
  [
    {
      text: "TEST 1",
      cb: () => {
        logger.info("TEST 1")
        return null
      },
    },
    {
      text: "TEST 2",
      cb: () => {
        logger.info("TEST 2")
        return null
      },
    },
  ],
])

export const testmenu = new CommandsCollection().createCommand({
  trigger: "testmenu",
  scope: "private",
  description: "Quick conversation",
  handler: async ({ context }) => {
    const menu = await generateMenu({
      chatId: context.chatId,
      messageId: context.message?.message_id ?? 0,
    })
    await context.reply("What is your name?", {
      reply_markup: menu,
    })
  },
})
