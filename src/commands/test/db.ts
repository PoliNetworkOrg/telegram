import { api } from "@/backend"
import { _commandsBase } from "../_base"
import { fmt } from "@/utils/format"

_commandsBase.createCommand({
  trigger: "test_db",
  scope: "private",
  description: "Test postgres db through the backend",
  handler: async ({ context }) => {
    try {
      const res = await api.test.dbQuery.query({ dbName: "tg" })
      await context.reply(
        fmt(({ code }) =>
          res.length > 0
            ? [`Elements inside`, code`tg_test`, `table:`, ...res.map((r) => `\n- ${r}`)]
            : [`No elements inside`, code`tg_test`, `table`]
        )
      )
    } catch (err) {
      await context.reply(`There was an error: \n${String(err)}`)
    }
  },
})
