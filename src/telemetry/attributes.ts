/** Semantic attribute keys for the bot domain */
export const BotAttributes = {
  /** Importance level: "high" = always sampled, "low" = rate-sampled */
  IMPORTANCE: "bot.importance",

  // Update attributes
  UPDATE_ID: "bot.update.id",
  UPDATE_TYPE: "bot.update.type",

  // Chat/User attributes
  CHAT_ID: "bot.chat.id",
  CHAT_TYPE: "bot.chat.type",
  USER_ID: "bot.user.id",
  USERNAME: "bot.user.username",

  // Command attributes
  COMMAND_NAME: "bot.command.name",
  COMMAND_SCOPE: "bot.command.scope",
  COMMAND_PERMITTED: "bot.command.permitted",

  // Automoderation attributes
  AUTOMOD_CHECK: "bot.automod.check",
  AUTOMOD_RESULT: "bot.automod.result",
  AUTOMOD_ACTION: "bot.automod.action",
  AUTOMOD_REASON: "bot.automod.reason",

  // Storage attributes
  STORAGE_OPERATION: "bot.storage.operation",
  STORAGE_COUNT: "bot.storage.count",

  // Cache attributes
  CACHE_OPERATION: "bot.cache.operation",

  // tRPC attributes
  TRPC_PROCEDURE: "bot.trpc.procedure",
  TRPC_SUCCESS: "bot.trpc.success",
} as const
