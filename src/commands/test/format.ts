import { CommandsCollection } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"

export const testformat = new CommandsCollection().createCommand({
  trigger: "test_format",
  scope: "private",
  description: "Test the formatting",
  handler: async ({ context }) => {
    const response = fmt(({ n, b, i, u, code, codeblock, link, strikethrough, spoiler }) => [
      `This is a message to`,
      b`test formatting`,
      `with`,
      i`multiple examples`,
      `like`,
      b`${u`concatened`}`,
      b`${u`multiple ${i`concatened`}`}`,
      `(also`,
      b`${i`concatened ${u`multiple`}`}`,
      `) and`,
      link(b`incredible links`, "https://polinetwork.org"),
      `and`,
      code`codeblocks`,
      codeblock`const assoc = 'polinetwork'`,
      `and other strange formatters:`,
      strikethrough`striked`,
      spoiler`spoiler`,
      n`(also normal with ${b`bold`})`,
    ])
    await context.reply(response)
  },
})
