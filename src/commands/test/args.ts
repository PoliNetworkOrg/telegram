import { _commandsBase } from "../_base"

_commandsBase.createCommand({
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
