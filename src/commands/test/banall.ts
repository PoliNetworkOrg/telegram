import { tgLogger } from "@/bot"
import type { BanAll } from "@/lib/tg-logger/ban-all"
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
        voters: [
          {
            user: {
              first_name: "PoliCreator1",
              id: 349275135,
            },
            isPresident: true,
            vote: undefined,
          },
          {
            user: {
              first_name: "Lorenzo",
              last_name: "Corallo",
              id: 186407195,
            },
            isPresident: false,
            vote: undefined,
          },
          {
            user: {
              first_name: "PoliCreator",
              last_name: "5",
              id: 1699796816,
            },
            isPresident: false,
            vote: undefined,
          },
        ],
      }

      await context.deleteMessage()
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
        voters: [
          {
            user: {
              first_name: "PoliCreator1",
              id: 349275135,
            },
            isPresident: true,
            vote: undefined,
          },
          {
            user: {
              first_name: "Lorenzo",
              last_name: "Corallo",
              id: 186407195,
            },
            isPresident: false,
            vote: undefined,
          },
          {
            user: {
              first_name: "PoliCreator",
              last_name: "5",
              id: 1699796816,
            },
            isPresident: false,
            vote: undefined,
          },
        ],
      }

      await context.deleteMessage()
      await tgLogger.banAll(banAllTest)
    },
  })
