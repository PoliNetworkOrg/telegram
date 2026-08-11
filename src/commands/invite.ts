import { api } from "@/backend"
import { CommandsCollection } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"
import type { Role } from "@/utils/types"

export const invite = new CommandsCollection<Role>().createCommand({
  trigger: "invite",
  description: "Display the bot's invite link of the group",
  scope: "group",
  handler: async ({ context }) => {
    const chat = await context.getChat()
    const inviteLink =
      chat.invite_link ?? (await api.tg.groups.getById.query({ telegramId: context.chatId }).catch(() => null))?.link

    if (!inviteLink) return void ephemeral(context.reply(fmt(({ n }) => n`❌ Cannot retrieve the invite link`)), 10_000)

    void ephemeral(context.reply(fmt(({ n }) => n`🔗 ${inviteLink}`)))
  },
})
