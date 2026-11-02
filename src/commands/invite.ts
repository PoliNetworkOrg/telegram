import { serviceBackend } from "@/backend"
import type { CommandAccess } from "@/commands/access"
import { CommandsCollection } from "@/lib/managed-commands"
import { fmt } from "@/utils/format"
import { ephemeral } from "@/utils/messages"

export const invite = new CommandsCollection<CommandAccess>().createCommand({
  trigger: "invite",
  description: "Display the bot's invite link of the group",
  scope: "group",
  handler: async ({ context }) => {
    const chat = await context.getChat()
    const inviteLink =
      chat.invite_link ??
      (await serviceBackend.tg.groups.getById.query({ telegramId: context.chatId }).catch(() => null))?.link

    if (!inviteLink)
      return void ephemeral(
        context,
        fmt(({ n }) => n`❌ Cannot retrieve the invite link`)
      )

    void ephemeral(
      context,
      fmt(({ n }) => n`🔗 ${inviteLink}`)
    )
  },
})
