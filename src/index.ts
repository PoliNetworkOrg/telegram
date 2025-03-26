import { logger } from './logger.ts'
import { Telex } from './Telex/index.ts'

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required!')
}
const bot = new Telex(process.env.BOT_TOKEN)
  .createCommand({
    trigger: 'name',
    description: 'Quick conversation',
    handler: async ({ conversation }) => {
      const name = await conversation.ask('What is your name?')
      await conversation.reply(`Hello, ${name}\\!`)
    },
  })
  .createCommand({
    trigger: 'ping',
    description: 'Replies with pong',
    handler: async ({ conversation }) => {
      await conversation.reply('pong')
    },
  })
  .createCommand({
    trigger: 'del',
    description: 'Deletes the replied to message',
    reply: 'required',
    handler: async ({ conversation, repliedTo }) => {
      const tg = conversation.getLastCtx() // questo dovrebbe essere nascosto in Telex
      const text = Telex.getText(repliedTo)
      logger.info({
        action: 'delete_message',
        messageText: text ?? '[Not a text message]',
        sender: repliedTo.from?.username,
      })
      await tg.deleteMessage(repliedTo.message_id)
      await tg.deleteMessage(tg.message.message_id)
    },
  })
  .createCommand({
    trigger: 'userid',
    description: 'Gets the ID of a username',
    args: { username: { description: 'The username to get the ID of' } },
    handler: async ({ conversation, args }) => {
      const username = args.username.replace('@', '')
      const id = await bot.getCachedId(username)
      if (!id) {
        logger.warn(`[userid] username @${username} not in our cache`)
        await conversation.reply(`Username @${username} not in our cache`)
        return
      }

      await conversation.reply(`Username \`@${username}\`\nid: \`${id}\``)
    },
  })

bot.start(() => logger.info('Bot started!'))
