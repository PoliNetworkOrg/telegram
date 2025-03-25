import { Context, Telegraf } from 'telegraf'
import { logger } from './logger.ts'
import type { Update } from 'telegraf/typings/core/types/typegram'
import { message } from "telegraf/filters"
import { getTelegramId, setTelegramId } from './redis.ts'
import type { Command } from './types/command.ts'
import { registerAll } from './commands/index.ts'

//import { client } from './redis.ts'

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN environment variable is required!')
}

export type TContext = Context<Update>
const bot = new Telegraf<TContext>(process.env.BOT_TOKEN)

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

export function registerCommand(command: Command) {
  bot.command(command.trigger, command.action)
}
registerAll()

bot.on(message("text"), (ctx, next) => {
  next()
  if (ctx.chat.type === "private") return;

  const { username, id } = ctx.message.from
  if (username) {
    setTelegramId(username, id)
  }
})


bot.help(async (ctx) => {
  if (ctx.chat.type !== 'private') {
    await ctx.deleteMessage(ctx.message.message_id)
    return
  }

  ctx.reply('This is a test!')
})

bot.command('ping', (ctx) => ctx.reply('pong'))

bot.command('userid', async (ctx) => {
  if (ctx.message.chat.type !== 'private') {
    return
  }

  const msg = ctx.message.text
  const username = msg.split(" ")[1]?.replace("@", "")
  if (!username){
    logger.error("[userid] the first param must be a username")
    return;
  }

  const id = await getTelegramId(username)
  if (!id) { 
    logger.warn(`[userid] username @${username} not in our cache`)
    await ctx.reply(`Username @${username} not in our cache`)
    return;
  }

  
  await ctx.reply(`Username \`@${username}\`\nid: \`${id}\``, { parse_mode: "MarkdownV2" })
})


bot.launch(() => logger.info('Bot started!'))

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
