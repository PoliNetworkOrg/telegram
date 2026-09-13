import type { Api, Context as TContext } from "grammy"
import type { User, UserFromGetMe } from "grammy/types"
import z from "zod"
import type { ApiInput, ApiOutput } from "@/backend"
import type { ManagedCommandsFlavor } from "@/lib/managed-commands"
import type { TelemetryContextFlavor } from "@/modules/telemetry"

export type ContextWith<C extends TContext, P extends keyof C> = C & {
  [K in P]: NonNullable<C[K]>
}

export type MaybePromise<T> = T | Promise<T>
export type MaybeArray<T> = T | T[]

export type Context = TelemetryContextFlavor<ManagedCommandsFlavor<TContext>>
export type Role = ApiInput["tg"]["permissions"]["addRole"]["role"]

export type ModuleShared = {
  api: Api
  botInfo: UserFromGetMe
}

export const numberOrString = z.string().transform((s) => {
  const n = Number(s)
  if (!Number.isNaN(n) && s.trim() !== "") return n
  return s
})

export const toGrammyUser = (apiUser: Exclude<ApiOutput["tg"]["users"]["get"]["user"], null | undefined>): User => ({
  id: apiUser.id,
  is_bot: apiUser.isBot,
  first_name: apiUser.firstName,
  last_name: apiUser.lastName,
  username: apiUser.username,
  language_code: apiUser.langCode,
  is_premium: undefined,
  added_to_attachment_menu: undefined,
})

export type PartialMessage = {
  message_id: number
  chat: { id: number }
}
