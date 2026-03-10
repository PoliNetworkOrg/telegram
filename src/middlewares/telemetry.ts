import type { MiddlewareFn } from "grammy"
import { BotAttributes, botMetrics, withSpan } from "@/telemetry"
import type { Context } from "@/utils/types"

function getUpdateType(update: Context["update"]): string {
  if ("message" in update && update.message) return "message"
  if ("edited_message" in update && update.edited_message) return "edited_message"
  if ("callback_query" in update && update.callback_query) return "callback_query"
  if ("inline_query" in update && update.inline_query) return "inline_query"
  if ("my_chat_member" in update && update.my_chat_member) return "my_chat_member"
  if ("chat_member" in update && update.chat_member) return "chat_member"
  if ("message_reaction" in update && update.message_reaction) return "message_reaction"
  if ("poll" in update && update.poll) return "poll"
  return "unknown"
}

/**
 * grammY middleware that wraps each incoming update in a root OTel span.
 * This becomes the parent span for all downstream operations (commands,
 * automoderation, storage, etc.) within that update's processing.
 */
export const telemetryMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const updateType = getUpdateType(ctx.update)

  botMetrics.updatesCount.add(1, { [BotAttributes.UPDATE_TYPE]: updateType })

  await withSpan(
    `bot.update.${updateType}`,
    {
      [BotAttributes.IMPORTANCE]: "high",
      [BotAttributes.UPDATE_ID]: ctx.update.update_id,
      [BotAttributes.UPDATE_TYPE]: updateType,
      [BotAttributes.CHAT_ID]: ctx.chat?.id ?? 0,
      [BotAttributes.CHAT_TYPE]: ctx.chat?.type ?? "unknown",
      [BotAttributes.USER_ID]: ctx.from?.id ?? 0,
      [BotAttributes.USERNAME]: ctx.from?.username ?? "unknown",
    },
    async () => {
      await next()
    }
  )
}
