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

  // Moderation attributes
  MODERATION_ACTION: "bot.moderation.action",
  MODERATION_RESULT: "bot.moderation.result",
  MODERATION_REASON: "bot.moderation.reason",
  MODERATION_ERROR_CODE: "bot.moderation.error_code",
  MODERATION_MODERATOR_ID: "bot.moderation.moderator_id",
  MODERATION_TARGET_ID: "bot.moderation.target_id",
  MODERATION_CHAT_COUNT: "bot.moderation.chat_count",
  MODERATION_TARGET_COUNT: "bot.moderation.target_count",
  MESSAGE_COUNT: "bot.message.count",

  // Storage attributes
  STORAGE_OPERATION: "bot.storage.operation",
  STORAGE_COUNT: "bot.storage.count",

  // Cache attributes
  CACHE_OPERATION: "bot.cache.operation",

  // tRPC attributes
  TRPC_PROCEDURE: "bot.trpc.procedure",
  TRPC_SUCCESS: "bot.trpc.success",
} as const
