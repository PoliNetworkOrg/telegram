import type { Context, Middleware } from "telegraf";
import type { Convenience, Message, Update } from "telegraf/types";
import type { TContext } from "../index.ts";

//type Ctx = Context<{
//    message: Update.New & Update.NonChannel & Message.TextMessage;
//    update_id: number;
//}> & Omit<Context<Update>, keyof Context> & StartContextExtn

type Action = Middleware<Context<{
    message: Update.New & Update.NonChannel & Message.TextMessage;
    update_id: number;
}> & Omit<TContext, keyof Context<Update>> & Convenience.CommandContextExtn>

export type Command = {
  trigger: string;
  desc: string;
  action: Action
}
