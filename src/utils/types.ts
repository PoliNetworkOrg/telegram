import type { Api, Context as TContext } from "grammy"
import type { User, UserFromGetMe } from "grammy/types"
import z from "zod"
import type { ApiInput, ApiOutput } from "@/backend"
import type { ManagedCommandsFlavor } from "@/lib/managed-commands"
import type { TelemetryContextFlavor } from "@/modules/telemetry"

export type OptionalPropertyOf<T extends object> = Exclude<
  {
    [K in keyof T]: T[K] extends undefined ? never : K
  }[keyof T],
  undefined
>
export type ContextWith<P extends OptionalPropertyOf<TContext>> = Exclude<TContext, P> & {
  [K in P]: NonNullable<TContext[P]>
}

export type MaybePromise<T> = T | Promise<T>
export type MaybeArray<T> = T | T[]

export type Context = TelemetryContextFlavor<ManagedCommandsFlavor<TContext>>
export type Role = ApiInput["tg"]["permissions"]["addRole"]["role"]

export type ModuleShared = {
  api: Api
  botInfo: UserFromGetMe
}

/**
 * Validates and transforms a string into a type-safe number.
 * 
 * Since the Telegram API sends all payload data and command arguments as strings, 
 * this schema serves as a strict gatekeeper. It ensures the string contains a valid 
 * numeric value safely rejecting text, whitespace, and empty strings—before 
 * casting it to a native JavaScript number.
 * 
 * @example
 * tgnumber.parse("42");      // Returns: 42
 * tgnumber.parse("abc");     // Throws: ZodError (Invalid numeric string)
 * tgnumber.parse("   ");     // Throws: ZodError (Prevents whitespace converting to 0)
 */
export const tgnumber = z  
  .string()  
  .trim()  
  .refine((s) => /^\d+$/.test(s), {  
    message: "Must be a valid positive integer string",  
  })  
  .transform(Number);  

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
