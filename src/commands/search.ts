import { InlineKeyboard } from "grammy"

import { api } from "@/backend"
import { fmt } from "@/utils/format"

import { _commandsBase } from "./_base"

const LIMIT = 9

_commandsBase.createCommand({
  trigger: "search",
  scope: "both",
  description: "Search groups by title",
  args: [{ key: "query", optional: false, description: "Search query" }],
  handler: async ({ context, args }) => {
    try {
      const res = await api.tg.groups.search.query({ query: args.query, limit: LIMIT })
      if (res.count === 0) {
        await context.reply(
          fmt(({ n, b, i }) => [b`🔎 Group Search`, n`${i`Query:`} ${b`${args.query}`}`, b`❌ No results`], {
            sep: "\n",
          })
        )
        return
      }

      const noInviteLink = res.groups.filter((g) => g.link === null)
      const reply = fmt(
        ({ n, b, i }) => [
          b`🔎 Group Search`,
          n`${i`Query:`} ${b`${args.query}`}`,
          n`${i`Count:`} ${b`${res.count}`} (max ${LIMIT})`,
          ...(noInviteLink.length
            ? [b`\nGroups without invite link:`, ...noInviteLink.map((g) => n`- ${g.title}`)]
            : []),
        ],
        {
          sep: "\n",
        }
      )

      const inlineKeyboard = new InlineKeyboard()
      res.groups
        .filter((g) => g.link !== null)
        .forEach((g, i) => {
          if (i % 3 === 0) inlineKeyboard.row()
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          inlineKeyboard.url(g.title, g.link!)
        })

      await context.reply(reply, { link_preview_options: { is_disabled: true }, reply_markup: inlineKeyboard })
    } catch (err) {
      await context.reply(fmt(({ n }) => [n`There was an error:`, n`\n${err}`]))
    }
  },
})
