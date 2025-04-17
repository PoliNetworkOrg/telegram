import type { CommandContext, Context as TContext } from "grammy"
import type { Conversation as TConversation, ConversationFlavor } from "@grammyjs/conversations"
import type { HydrateFlavor } from "@grammyjs/hydrate"
import type { ParseModeFlavor } from "@grammyjs/parse-mode"

// NOTE: ParseModeFlavor must stay as the outer one
export type Context = ParseModeFlavor<HydrateFlavor<ConversationFlavor<TContext>>>
export type ConversationContext = CommandContext<ParseModeFlavor<HydrateFlavor<TContext>>>
export type Conversation = TConversation<Context, ConversationContext>
