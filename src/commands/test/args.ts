import { CommandsCollection } from "@/lib/managed-commands"
import type { Role } from "@/utils/types"

export const testargs = new CommandsCollection<Role>().createCommand({
  trigger: "test_args",
  scope: "private",
  description: "Test args",
  args: [
    { key: "arg1", description: "first arg" },
    { key: "arg2", description: "second arg", optional: false },
    { key: "arg3", description: "the optional one", optional: true },
  ],
  handler: async ({ context, args }) => {
    console.log(args)
    await context.reply("pong")
  },
})
