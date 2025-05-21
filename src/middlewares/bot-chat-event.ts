import type { Context } from "@/lib/managed-commands"
import type { AppRouter } from "@polinetwork/backend"
import type { TRPCClient } from "@trpc/client"
import type { Chat, ChatFullInfo } from "grammy/types"
import type { Result } from "neverthrow"

import { Composer, type Filter, InlineKeyboard, type MiddlewareFn, type MiddlewareObj } from "grammy"
import { err, ok } from "neverthrow"

import { api } from "@/backend"
import { logger } from "@/logger"
import { fmt, fmtUser } from "@/utils/format"

type GroupDB = Parameters<TRPCClient<AppRouter>["tg"]["groups"]["create"]["mutate"]>[0][0]
type ChatType = "group" | "supergroup" | "private" | "channel"
type StatusType = "member" | "administrator" | "creator" | "restricted" | "left" | "kicked"

// if added as member, tg fires:
// group -> "member"
// supergroup -> "member"
// channel -> cannot happen
//
// if added as admin, tg fires:
// group -> "member" AND "administrator"
// supergroup -> "administrator"
// channel -> "administrator"
//
// therefore on group we only listen for "member", on channel for "administrator", on supergroup for both
// in private we never listen to this event
//
//
const joinEvent: Record<ChatType, StatusType[]> = {
  group: ["member"],
  supergroup: ["member", "administrator"],
  channel: ["administrator"],
  private: [],
}

type MemberContext<C extends Context> = Filter<C, "my_chat_member">
export class BotChatEvent<C extends Context> implements MiddlewareObj<C> {
  private composer = new Composer<C>()

  constructor(private logChannelId: number) {
    this.composer.on("my_chat_member", async (ctx, next) => {
      const chat = ctx.myChatMember.chat
      const newStatus = ctx.myChatMember.new_chat_member.status
      if (chat.type === "private") return next()

      if (joinEvent[chat.type].includes(newStatus)) {
        // joined event
        const ok = await this.checkAdderPermission(ctx)
        if (!ok) return next()
      }

      if (newStatus === "administrator") {
        // promoted to admin event
        //CANNOT create group "${chat.title}" [${chat.id}] in DB --
        const chat = await ctx.getChat()
        const createRes = await this.createGroup(chat)
        await createRes.match(
          async (g) => {
            await ctx.api.sendMessage(
              this.logChannelId,
              fmt(
                ({ n, b, code }) => [
                  b`✳️ Group created`,
                  n`${b`Title:`} ${g.title}`,
                  n`${b`Id:`} ${code`${g.telegramId}`}`,
                  n`${b`Added by:`} ${fmtUser(ctx.myChatMember.from)}`,
                ],
                {
                  sep: "\n",
                }
              ),
              {
                reply_markup: new InlineKeyboard().url("Join Group", g.link),
              }
            )
            logger.info({ chat }, `[BCE] Created a new group`)
          },
          async (e) => {
            const ik = new InlineKeyboard()
            if (chat.invite_link) ik.url("Join Group", chat.invite_link)
            await ctx.api.sendMessage(
              this.logChannelId,
              fmt(
                ({ n, b, i, code }) => [
                  b`⚠️ Cannot create group`,
                  chat.title ? n`${b`Title:`} ${chat.title}` : undefined,
                  n`${b`Id`}: ${code`${chat.id}`}`,
                  n`${b`Reason`}: ${e}`,
                  i`Check logs for more details`,
                ],
                { sep: "\n" }
              ),
              {
                reply_markup: chat.invite_link ? new InlineKeyboard().url("Join Group", chat.invite_link) : undefined,
              }
            )
            logger.error({ chat }, `[BCE] Cannot create group into DB. Reason: ${e}`)
          }
        )
      }

      if (newStatus === "left" || newStatus === "kicked") {
        // left event
        //
        const deleteRes = await this.deleteGroup(chat)
        await deleteRes.match(
          async () => {
            await ctx.api.sendMessage(
              this.logChannelId,
              fmt(
                ({ n, b, code }) => [
                  b`💥 Group deleted`,
                  n`${b`Title:`} ${chat.title}`,
                  n`${b`Id:`} ${code`${chat.id}`}`,
                ],
                {
                  sep: "\n",
                }
              )
            )
            logger.info({ chat }, `[BCE] Deleted a group`)
          },
          (e) => {
            logger.error({ chat }, `[BCE] Cannot delete group from DB. Reason: ${e}`)
          }
        )
      }

      if (newStatus === "restricted") {
        //
      }

      await next()
    })
  }

  middleware(): MiddlewareFn<C> {
    return this.composer.middleware()
  }

  private async checkAdderPermission(ctx: MemberContext<C>): Promise<boolean> {
    const { allowed } = await api.tg.permissions.canAddBot.query({ userId: ctx.myChatMember.from.id })
    if (!allowed) {
      const left = await ctx.leaveChat().catch(() => false)
      if (left) {
        await ctx.api.sendMessage(
          this.logChannelId,
          fmt(
            ({ b, code, n }) => [
              b`💨 Left unauthorized group`,
              n`${b`Title:`} ${ctx.myChatMember.chat.title ?? ""}`,
              n`${b`Id:`} ${code`${ctx.myChatMember.chat.id}`}`,
              n`${b`Added by:`} ${fmtUser(ctx.myChatMember.from)}`,
            ],
            { sep: "\n" }
          )
        )
        logger.info({ chat: ctx.myChatMember.chat, from: ctx.myChatMember.from }, `[BCE] Left unauthorized group`)
      } else {
        await ctx.api.sendMessage(
          this.logChannelId,
          fmt(
            ({ b, code, n }) => [
              b`‼️ Cannot left unauthorized group`,
              n`${b`Title:`} ${ctx.myChatMember.chat.title ?? ""}`,
              n`${b`Id:`} ${code`${ctx.myChatMember.chat.id}`}`,
              n`${b`Added by:`} ${fmtUser(ctx.myChatMember.from)}`,
            ],
            { sep: "\n" }
          )
        )
        logger.error(
          { chat: ctx.myChatMember.chat, from: ctx.myChatMember.from },
          `[BCE] Cannot left unauthorized group`
        )
      }
    }
    return allowed
  }

  private async deleteGroup(chat: Chat): Promise<Result<void, string>> {
    const deleted = await api.tg.groups.delete.mutate({ telegramId: chat.id })
    if (!deleted) return err("it probably wasn't there")
    return ok()
  }

  private async createGroup(chat: ChatFullInfo): Promise<Result<GroupDB, string>> {
    if (!chat.invite_link) {
      return err(`no invite_link, maybe the user does not have permission to "Invite users via link"`)
    }

    const newGroup: GroupDB = { telegramId: chat.id, title: chat.title, link: chat.invite_link }
    const res = await api.tg.groups.create.mutate([newGroup])
    if (!res.length || res[0] !== chat.id) {
      return err(`unknown`)
    }

    return ok(newGroup)
  }
}
