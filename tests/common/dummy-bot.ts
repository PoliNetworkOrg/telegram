import { type ApiCallFn, Bot, type Context, type RawApi } from "grammy"
import type { Update } from "grammy/types"

type ApiFunction = ApiCallFn<RawApi>
export type ResultType = Awaited<ReturnType<ApiFunction>>
type Params = Parameters<ApiFunction>
type PayloadType = Params[1]
export type OutgoingRequest = {
  method: string
  payload: PayloadType
}

/** Returns the current timestamp in seconds since the Unix epoch. */
function now() {
  return Math.floor(Date.now() / 1000)
}

/**
 * Creates a dummy bot instance for testing purposes.
 * @returns An object containing the dummy bot and an array to capture outgoing API requests
 */
export async function createDummyBot<C extends Context>() {
  const bot = new Bot<C>("token")
  const outgoingRequests: OutgoingRequest[] = []

  bot.api.config.use(async (_, method, payload) => {
    outgoingRequests.push({ method, payload })
    return { ok: true, result: true as ResultType }
  })

  bot.botInfo = {
    id: 42,
    first_name: "Dummy Bot",
    is_bot: true,
    username: "dummy_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  }

  await bot.init()

  return {
    bot,
    outgoingRequests,
  }
}

/** Generates a dummy command call `Update` for testing purposes. */
export function generateCommandCall(trigger: string, id: number = 0): Update {
  return {
    update_id: 0,
    message: {
      text: `/${trigger}`,
      message_id: 0,
      date: now(),
      entities: [
        {
          type: "bot_command",
          offset: 0,
          length: trigger.length + 1,
        },
      ],
      chat: {
        id,
        first_name: "Test",
        last_name: "Lastest",
        username: "testuser",
        type: "private",
      },
      from: {
        id,
        first_name: "Test",
        last_name: "Lastest",
        username: "testuser",
        is_bot: false,
      },
    },
  }
}

/** Generates a dummy command call `Update` for testing purposes, from a group chat */
export function generateGroupCommandCall(trigger: string, id: number = 0): Update {
  return {
    update_id: 0,
    message: {
      text: `/${trigger}`,
      message_id: 0,
      date: now(),
      entities: [
        {
          type: "bot_command",
          offset: 0,
          length: trigger.length + 1,
        },
      ],
      chat: {
        id,
        title: "Test Group",
        type: "group",
      },
      from: {
        id,
        first_name: "Test",
        last_name: "Lastest",
        username: "testuser",
        is_bot: false,
      },
    },
  }
}

/** Generates a dummy text message `Update` for testing purposes. */
export function generateMessage(text: string, id: number = 0): Update {
  return {
    update_id: 0,
    message: {
      text,
      message_id: 0,
      date: now(),
      chat: {
        id,
        first_name: "Test",
        last_name: "Lastest",
        username: "testuser",
        type: "private",
      },
      from: {
        id,
        first_name: "Test",
        last_name: "Lastest",
        username: "testuser",
        is_bot: false,
      },
    },
  }
}

/** Generates a dummy text message `Update` for testing purposes, from a group chat */
export function generateGroupMessage(text: string, id: number = 0): Update {
  return {
    update_id: 0,
    message: {
      text,
      message_id: 0,
      date: now(),
      chat: {
        id,
        title: "Test Group",
        type: "group",
      },
      from: {
        id,
        first_name: "Test",
        last_name: "Lastest",
        username: "testuser",
        is_bot: false,
      },
    },
  }
}
