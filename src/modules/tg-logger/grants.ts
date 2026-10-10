import { TRPCClientError } from "@trpc/client"
import type { Context } from "grammy"
import type { Message, User } from "grammy/types"
import {
  authorizeAction,
  DENIED,
  decideAccess,
  decisionMode,
  hasPermission,
  legacyRoles,
  PERMISSION,
  resolveOne,
} from "@/access"
import { type ApiOutput, backendAs, backendFor, legacyBackend } from "@/backend"
import { type CallbackCtx, MenuGenerator } from "@/lib/menu"
import { logger } from "@/logger"
import { modules } from ".."
import { Moderation } from "../moderation"

type GrantedMessage = {
  message: Message
  chatId: number
  target: User
  deleted: boolean
  interrupted: boolean
}

type InterruptResult = ApiOutput["tg"]["grants"]["interrupt"]

/**
 * Interrupting is checked by the backend (RFC v3 §10.2): with IdP decisions it acts for the user,
 * who needs `tg:grants:manage`; before that the legacy path checks the stored roles, and in shadow
 * mode the IdP decision is only compared.
 */
async function interruptGrant(from: User, target: User): Promise<InterruptResult> {
  if (decisionMode === "enforce")
    return backendAs(from.id)
      .tg.grants.interrupt.mutate({ userId: target.id })
      .catch((error: unknown) => {
        if (error instanceof TRPCClientError && error.data?.code === "FORBIDDEN")
          return { success: false, error: "UNAUTHORIZED" } as const
        throw error
      })

  const legacy = legacyBackend.tg.grants.interrupt.mutate({ interruptedById: from.id, userId: target.id })
  if (decisionMode === "shadow")
    await decideAccess({
      check: "grants_menu:interrupt",
      ids: { actorId: from.id, targetId: target.id },
      legacy: async () => (await legacy).error !== "UNAUTHORIZED",
      idp: async () => hasPermission(await resolveOne(backendFor(from), from.id), PERMISSION.grantsManage),
    }).catch(() => {})
  return legacy
}

async function handleInterrupt(ctx: CallbackCtx<Context>, target: User) {
  const res = await interruptGrant(ctx.from, target)
  logger.debug({ res }, "handleInterrupt function in grants menu")
  if (!res.success) {
    return { error: res.error }
  }

  await modules.get("tgLogger").grants({ action: "INTERRUPT", by: ctx.from, target: target })
  return { error: null }
}

type Error = ApiOutput["tg"]["grants"]["interrupt"]["error"] | "DELETE_ERROR" | "DELETE_NOT_FOUND" | null
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
    case "DELETE_NOT_FOUND":
      return "☑️ Message already deleted or is unreachable"
    case "DELETE_ERROR":
      return "⁉️ Cannot delete message, please check logs"
  }
}

async function handleDelete(ctx: CallbackCtx<Context>, data: GrantedMessage): Promise<{ error: Error }> {
  const userId = ctx.from.id
  const authorization = await authorizeAction({
    check: "grants_menu:delete",
    actorId: userId,
    backend: backendFor(ctx.from),
    required: [PERMISSION.grantsManage],
    legacy: async () =>
      (await legacyRoles(userId)).includes("direttivo") ? { allowed: true, basis: "idp_permission" } : DENIED,
  })
  if (!authorization.allowed) return { error: "UNAUTHORIZED" }

  const res = await Moderation.deleteMessages(
    [data.message],
    ctx.from,
    "[GRANT] Manual deletion of message sent by granted user"
  )

  if (res.isErr()) {
    return {
      error: res.error === "NOT_FOUND" ? "DELETE_NOT_FOUND" : "DELETE_ERROR",
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
