import { Telegraf } from 'telegraf'

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required!')
}
const bot = new Telegraf(process.env.BOT_TOKEN)
bot.start(async (ctx) => {
  ctx.setChatMenuButton({ type: 'commands' })
  ctx.reply('Welcome from PoliNetwork!')
})
bot.telegram.setMyCommands([
  { command: 'help', description: 'Help command' },
  { command: 'ping', description: 'Test command' },
])
bot.help((ctx) => ctx.reply('This is a test!'))
bot.command('ping', (ctx) => ctx.reply('pong'))
bot.launch()

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
