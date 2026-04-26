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

export function generateCommandCall(trigger: string, id: number = 0): Update {
  return {
    update_id: 0,
    message: {
      text: `/${trigger}`,
      message_id: 0,
      date: Date.now(),
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

export function generateGroupCommandCall(trigger: string, id: number = 0): Update {
  return {
    update_id: 0,
    message: {
      text: `/${trigger}`,
      message_id: 0,
      date: Date.now(),
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

export function generateMessage(text: string, id: number = 0): Update {
  return {
    update_id: 0,
    message: {
      text,
      message_id: 0,
      date: Date.now(),
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

export function generateGroupMessage(text: string, id: number = 0): Update {
  return {
    update_id: 0,
    message: {
      text,
      message_id: 0,
      date: Date.now(),
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
