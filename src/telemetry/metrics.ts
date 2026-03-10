import { metrics } from "@opentelemetry/api"

const meter = metrics.getMeter("polinetwork-telegram-bot")

export const botMetrics = {
  commandsCount: meter.createCounter("bot.commands.count", {
    description: "Number of bot commands processed",
    unit: "{command}",
  }),

  automodActions: meter.createCounter("bot.automod.actions", {
    description: "Number of automoderation actions taken",
    unit: "{action}",
  }),

  updatesCount: meter.createCounter("bot.updates.count", {
    description: "Number of bot updates processed",
    unit: "{update}",
  }),

  storageBufferSize: meter.createUpDownCounter("bot.storage.buffer_size", {
    description: "Current size of the message storage buffer",
    unit: "{message}",
  }),

  trpcDuration: meter.createHistogram("bot.trpc.duration", {
    description: "Duration of tRPC calls",
    unit: "ms",
  }),
}
