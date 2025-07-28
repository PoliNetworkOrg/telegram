import type { ConversationFlavor } from "@grammyjs/conversations"
import type { HydrateFlavor } from "@grammyjs/hydrate"
import type { ParseModeFlavor } from "@grammyjs/parse-mode"
import type { ChatTypeContext, CommandContext, Context as TContext } from "grammy"
import type { Chat, Message } from "grammy/types"

// NOTE: ParseModeFlavor must stay as the outer one
export type Context = ParseModeFlavor<HydrateFlavor<ConversationFlavor<TContext>>>
export type ConversationContext<CT extends Chat["type"]> = ParseModeFlavor<
  HydrateFlavor<CommandContext<ChatTypeContext<TContext, CT>>>
>
