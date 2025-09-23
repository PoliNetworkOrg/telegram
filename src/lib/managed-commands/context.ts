import type { ConversationFlavor } from "@grammyjs/conversations"
import type { HydrateFlavor } from "@grammyjs/hydrate"
import type { ParseModeFlavor } from "@grammyjs/parse-mode"
import type { ChatTypeContext, CommandContext, Context } from "grammy"
import type { Chat } from "grammy/types"

// NOTE: ParseModeFlavor must stay as the outer one

export type ManagedCommandsFlavor<C extends Context = Context> = ParseModeFlavor<HydrateFlavor<ConversationFlavor<C>>>
export type ConversationContext<CT extends Chat["type"]> = ParseModeFlavor<
  HydrateFlavor<CommandContext<ChatTypeContext<Context, CT>>>
>
