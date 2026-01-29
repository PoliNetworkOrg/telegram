import type { Context } from "grammy"
import type { Message, User } from "grammy/types"
import { type ApiOutput, api } from "@/backend"
import { type CallbackCtx, MenuGenerator } from "@/lib/menu"
import { logger } from "@/logger"
import { modules } from ".."

type GrantedMessage = {
  message: Message
  chatId: number
  target: User
  deleted: boolean
  interrupted: boolean
}

async function handleInterrupt(ctx: CallbackCtx<Context>, target: User) {
  const res = await api.tg.grants.interrupt.mutate({ interruptedById: ctx.from.id, userId: target.id })
  logger.debug({ res }, "handleInterrupt function in grants menu")
  if (!res.success) {
    return { error: res.error }
  }

  await modules.get("tgLogger").grants({ action: "INTERRUPT", by: ctx.from, target: target })
  return { error: null }
}

type Error = ApiOutput["tg"]["grants"]["interrupt"]["error"] | "CANNOT_DELETE" | null
const getFeedback = (error: Error): string | null => {
  switch (error) {
    case null:
      return null
    case "NOT_FOUND":
      return "☑️ Grant already expired or interrupted"
    case "UNAUTHORIZED":
      return "❌ You don't have enough permissions"
    case "INTERNAL_SERVER_ERROR":
      return "⁉️ Backend error, please check logs"
    case "CANNOT_DELETE":
      return "⁉️ Cannot delete, maybe message already deleted"
  }
}

async function handleDelete(ctx: CallbackCtx<Context>, data: GrantedMessage): Promise<{ error: Error }> {
  const { roles } = await api.tg.permissions.getRoles.query({ userId: ctx.from.id })
  if (!roles?.includes("direttivo")) return { error: "UNAUTHORIZED" }

  await modules
    .get("tgLogger")
    .preDelete([data.message], "[GRANT] Manual deletion of message sent by granted user", ctx.from)

  const ok = await ctx.api.deleteMessages(data.message.chat.id, [data.message.message_id]).catch(() => false)
  if (!ok) {
    return {
      error: "CANNOT_DELETE",
    }
  }

  return { error: null }
}

/**
 * Interactive menu for interacting with granted message.
 *
 * @param data - {@link GrantedMessage} grant info
 */
export const grantMessageMenu = MenuGenerator.getInstance<Context>().create<GrantedMessage>("grants-message", [
  [
    {
      text: "🗑",
      cb: async ({ ctx, data }) => {
        if (data.deleted) return { feedback: "☑️ Message already deleted" }
        const { error } = await handleDelete(ctx, data)
        if (!error && data.interrupted) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
        return {
          feedback: getFeedback(error) ?? "✅ Message deleted",
          newData: !error ? { ...data, deleted: true } : undefined,
        }
      },
    },
    {
      text: "🛑",
      cb: async ({ ctx, data }) => {
        if (data.interrupted) return { feedback: "☑️ Grant already interrupted" }
        const { error } = await handleInterrupt(ctx, data.target)
        const noError = !error || error === "NOT_FOUND"
        if (noError && data.deleted) await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
        return {
          feedback: getFeedback(error) ?? "✅ Grant Interrupted",
          newData: noError ? { ...data, interrupted: true } : undefined,
        }
      },
    },
  ],
])

/**
 * Interactive menu for interacting with newly created grant.
 *
 * @param data - {@link User} granted grammy's User
 */
export const grantCreatedMenu = MenuGenerator.getInstance<Context>().create<User>("grants-create", [
  [
    {
      text: "🛑 Interrupt",
      cb: async ({ ctx, data }) => {
        const { error } = await handleInterrupt(ctx, data)
        logger.info({ error }, "handleInterrupt error output in created menu")
        if (!error || error === "NOT_FOUND")
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
        return {
          feedback: getFeedback(error) ?? "✅ Grant Interrupted",
        }
      },
    },
  ],
])
