import { fmt } from "@/utils/format";

import { _commandsBase } from "../_base";
import { menuGenerator } from "@/bot";
import { logger } from "@/logger";

const generateMenu = menuGenerator.create<{
  messageId: number;
  chatId: number;
}>("test-name", [
  [
    {
      text: fmt(({ b }) => b`🗑 Delete + 🚫 Ban`),
      cb: (data) => {
        logger.info({ data }, "TESTSTESTSTSTE");
      },
    },
  ],
  [
    {
      text: "TEST 1",
      cb: () => {
        logger.info("TEST 1");
      },
    },
    {
      text: "TEST 2",
      cb: () => {
        logger.info("TEST 2");
      },
    },
  ],
]);

_commandsBase.createCommand({
  trigger: "testmenu",
  scope: "private",
  description: "Quick conversation",
  handler: async ({ context }) => {
    const menu = await generateMenu({
      chatId: context.chatId,
      messageId: context.message?.message_id ?? 0,
    });
    await context.reply("What is your name?", {
      reply_markup: menu,
    });
  },
});
