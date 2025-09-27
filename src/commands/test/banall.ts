import { tgLogger } from "@/bot"
import type { BanAll } from "@/lib/tg-logger/ban-all"
import { _commandsBase } from "../_base"
import { api } from "@/backend"
import { fmt } from "@/utils/format"

_commandsBase
  .createCommand({
    trigger: "test_banall",
    description: "TEST - PREMA BAN a user from all the Network's groups",
    scope: "private",
    permissions: {
      allowedRoles: ["owner"],
    },
    handler: async ({ context }) => {
      await context.deleteMessage()
      const direttivo = await api.tg.permissions.getDirettivo.query()
      if (direttivo.error) {
        await context.reply(fmt(({ n }) => n`${direttivo.error}`))
        return
      }

      const voters = direttivo.members.map((m) => ({
        user: { id: m.userId },
        isPresident: m.isPresident,
        vote: undefined,
      }))

      const banAllTest: BanAll = {
        type: "BAN",
        outcome: "waiting",
        reporter: context.from,
        reason: "Testing ban all voting system",
        target: {
          first_name: "PoliCreator",
          last_name: "3",
          id: 728441822, // policreator3 - unused
          is_bot: false,
          username: "policreator3",
        },
        voters,
      }

      await tgLogger.banAll(banAllTest)
    },
  })
  .createCommand({
    trigger: "test_unbanall",
    description: "TEST - UNBAN a user from the network",
    scope: "private",
    permissions: {
      allowedRoles: ["owner"],
    },
    handler: async ({ context }) => {
      await context.deleteMessage()
      const direttivo = await api.tg.permissions.getDirettivo.query()
      if (direttivo.error) {
        await context.reply(fmt(({ n }) => n`${direttivo.error}`))
        return
      }

      const voters = direttivo.members.map((m) => ({
        user: { id: m.userId },
        isPresident: m.isPresident,
        vote: undefined,
      }))

      const banAllTest: BanAll = {
        type: "UNBAN",
        outcome: "waiting",
        reporter: context.from,
        reason: "Testing ban all voting system",
        target: {
          first_name: "PoliCreator",
          last_name: "3",
          id: 728441822, // policreator3 - unused
          is_bot: false,
          username: "policreator3",
        },
        voters,
      }

      await tgLogger.banAll(banAllTest)
    },
  })
