import { api } from "@/backend"
import type { BanAll } from "@/lib/tg-logger/ban-all"
import { modules } from "@/modules"
import { fmt } from "@/utils/format"
import { _commandsBase } from "../_base"

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

      if (!voters.some((v) => v.isPresident)) {
        await context.reply(
          fmt(({ n, b }) => [b`No member is President!`, n`${b`Members:`} ${voters.map((v) => v.user.id).join(" ")}`], {
            sep: "\n",
          })
        )
        return
      }

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

      await modules.get("tgLogger").banAll(banAllTest)
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

      if (!voters.some((v) => v.isPresident)) {
        await context.reply(
          fmt(({ n, b }) => [b`No member is President!`, n`${b`Members:`} ${voters.map((v) => v.user.id).join(" ")}`], {
            sep: "\n",
          })
        )
        return
      }

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

      await modules.get("tgLogger").banAll(banAllTest)
    },
  })
