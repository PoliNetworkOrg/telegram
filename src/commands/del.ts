import { logger } from '../logger.ts'
import { getMsgText } from '../utils/message.ts'
import type { Command } from '../types/command.ts'

export default {
  trigger: 'del',
  desc: 'Delete a message in a group chat',
  async action(ctx) {
    if (ctx.message.chat.type === 'private') {
      ctx.reply('This command is only available in groups.')
      return
    }

    if (ctx.message?.reply_to_message) {
      const messageId = ctx.message.reply_to_message.message_id
      const text = getMsgText(ctx.message.reply_to_message)

      logger.info({
        action: 'delete_message',
        messageText: text ?? '[Not a text message]',
        sender: ctx.message.reply_to_message.from?.username,
      })
      await ctx.deleteMessage(messageId)
      const reply = await ctx.reply('Message deleted!')
      setTimeout(() => {
        ctx.deleteMessage(ctx.message.message_id)
        ctx.deleteMessage(reply.message_id)
      }, 3000)
    } else {
      const reply = await ctx.reply('Please reply to a message to delete it.')
      setTimeout(() => {
        ctx.deleteMessage(ctx.message.message_id)
        ctx.deleteMessage(reply.message_id)
      }, 3000)
    }
  },
} satisfies Command
