import { Telegraf } from 'telegraf'
import { logger } from './logger.ts'
import type { Message } from 'telegraf/typings/core/types/typegram'

function getText(message: Message): string | null {
  return 'text' in message && message.text !== undefined ? message.text : null
}

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required!')
}
const bot = new Telegraf(process.env.BOT_TOKEN)

bot.start(async (ctx) => {
  if (ctx.chat?.type !== 'private') {
    return
  }
  ctx.setChatMenuButton({ type: 'commands' })
  ctx.reply('Welcome from PoliNetwork!')
})

bot.telegram.setMyCommands([
  { command: 'help', description: 'Help command' },
  { command: 'ping', description: 'Test command' },
])

bot.help(async (ctx) => {
  if (ctx.chat.type !== "private") {
    await ctx.deleteMessage(ctx.message.message_id)
    return;
  }

  ctx.reply('This is a test!') 
})

bot.command('ping', (ctx) => ctx.reply('pong'))

bot.command('del', async (ctx) => {
  if (ctx.message.chat.type === 'private') {
    ctx.reply('This command is only available in groups.')
    return
  }

  if (ctx.message?.reply_to_message) {
    const messageId = ctx.message.reply_to_message.message_id
    const text = getText(ctx.message.reply_to_message)

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
})
bot.launch(() => logger.info('Bot started!'))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
