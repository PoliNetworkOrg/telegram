import { Composer, type Context, type Filter, InlineKeyboard, type MiddlewareObj } from "grammy"
import { nanoid } from "nanoid"

import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { redis } from "@/redis"
import { nanohash } from "@/utils/crypto"
import type { MaybePromise } from "@/utils/types"

const CONSTANTS = {
  prefix: "menugen",
  maxRows: 100,
  maxCols: 12,
  hashLen: 16,
  padLen: 3,
}

export type CallbackCtx<C extends Context> = Filter<C, "callback_query:data">
// biome-ignore lint/suspicious/noConfusingVoidType: literally a bug in Biome
type Callback<T, C extends Context> = (params: { data: T; ctx: CallbackCtx<C> }) => MaybePromise<string | void>

class Menu<T, C extends Context = Context> {
  private dataStorage: RedisFallbackAdapter<T>
  private callbacks: Map<string, Callback<T, C>> = new Map()

  constructor(
    private hashedId: string,
    private items: Array<Array<{ text: string; cb: Callback<T, C> }>>,
    public onExpiredButtonPress?: Callback<null, C>
  ) {
    this.dataStorage = new RedisFallbackAdapter({
      redis,
      prefix: `menu-data:${this.hashedId}`,
      ttl: 60 * 60 * 24 * 30, // 30 days
    })

    // Initialize menu with type T
    items.forEach((row, rowIndex) => {
      row.forEach((item, colIndex) => {
        const buttonId = `${rowIndex}:${colIndex}`
        this.callbacks.set(buttonId, item.cb)
      })
    })
  }

  async generateKeyboard(data: T): Promise<InlineKeyboard> {
    // this Id is unique to the message to which the inlineKeyboard is attached
    // this means that it is unique to the message itself
    const keyboardId = nanoid(CONSTANTS.hashLen)
    await this.dataStorage.write(keyboardId, data)

    const keyboard = new InlineKeyboard()
    this.items.forEach((row, rowIndex) => {
      row.forEach((item, colIndex) => {
        // TODO: add possibility to add non-callback buttons, like url
        const callbackId = MenuGenerator.toCallbackId(this.hashedId, rowIndex, colIndex, keyboardId)

        if (callbackId) keyboard.text(item.text, callbackId)
      })

      if (rowIndex < this.items.length - 1) keyboard.row()
    })
    return keyboard
  }

  async call(ctx: CallbackCtx<C>, row: number, col: number, keyboardId: string) {
    const buttonId = `${row}:${col}`
    const callback = this.callbacks.get(buttonId)
    if (!callback) throw new Error(`Callback not found for buttonId(row,col): ${buttonId}`)

    const data = await this.dataStorage.read(keyboardId)
    if (!data) throw new Error(`Data in redis not found for buttonId(row,col): ${buttonId}`)

    return await callback({ data, ctx })
  }
}

export class MenuGenerator<C extends Context> implements MiddlewareObj<C> {
  private static instance: MenuGenerator<Context> | null = null
  static getInstance<C extends Context>(): MenuGenerator<C> {
    if (!MenuGenerator.instance) {
      MenuGenerator.instance = new MenuGenerator<Context>()
    }
    return MenuGenerator.instance as unknown as MenuGenerator<C>
  }

  static toCallbackId(menuHash: string, row: number, col: number, keyboardId: string): string | null {
    if (menuHash.length !== CONSTANTS.hashLen) return null
    if (row > CONSTANTS.maxRows || col > CONSTANTS.maxCols) {
      logger.warn({ row, col }, "[MenuGen] Asking to create a callbackId with row or col too high!")
      return null
    }

    const paddedRow = row.toString().padStart(CONSTANTS.padLen, "0")
    const paddedCol = col.toString().padStart(CONSTANTS.padLen, "0")
    return `${CONSTANTS.prefix}:${menuHash}:${paddedRow}:${paddedCol}:${keyboardId}`
  }

  static fromCallbackId(
    callbackData: string
  ): { menuHash: string; row: number; col: number; keyboardId: string } | null {
    const parts = callbackData.split(":")
    if (parts.length !== 5) return null

    const [_, menuHash, rowStr, colStr, keyboardId] = parts
    if (
      menuHash.length !== CONSTANTS.hashLen ||
      keyboardId.length !== CONSTANTS.hashLen ||
      rowStr.length !== CONSTANTS.padLen ||
      colStr.length !== CONSTANTS.padLen
    )
      return null

    const row = parseInt(rowStr, 10)
    const col = parseInt(colStr, 10)
    if (Number.isNaN(row) || Number.isNaN(col)) return null

    return { menuHash, row, col, keyboardId }
  }

  private composer: Composer<C> = new Composer<C>()
  private menus: Map<string, Menu<unknown>> = new Map()

  private constructor() {
    this.composer.on("callback_query:data", (ctx, next) => {
      // Handle callback query
      const callbackData = ctx.callbackQuery.data
      if (!callbackData.startsWith(CONSTANTS.prefix)) return next()

      const parsed = MenuGenerator.fromCallbackId(callbackData)
      if (!parsed) return next()

      const { menuHash, row, col, keyboardId } = parsed
      const menu = this.menus.get(menuHash)
      if (!menu) return next()

      return menu
        .call(ctx, row, col, keyboardId)
        .then((result) => {
          return ctx.answerCallbackQuery({ text: result ?? undefined })
        })
        .catch(async (e: unknown) => {
          logger.error({ e }, "ERROR WHILE CALLING MENU CB")
          await ctx.editMessageReplyMarkup().catch(() => {})
          const feedback = menu.onExpiredButtonPress && (await menu.onExpiredButtonPress({ data: null, ctx }))
          await ctx.answerCallbackQuery({ text: feedback ?? "This button is no longer available", show_alert: true })
        })
    })
  }

  /**
   * Creates an inline keyboard in which buttons have specific callbacks.
   *
   * @typeParam T - The type of the data associated with each menu instance.
   * @param id - A unique identifier for the menu, used to generate a hash for distinguishing different menus.
   * @param items - A 2D array representing the grid layout of the menu buttons, where
   *   each inner array is a row of button with an object specifying its text and callback.
   *   The callback has access to the menu data and to the callbackQuery context, returns
   *   an optional string to display a specific alert to the user.
   * @param onExpiredButtonPress - Optional callback executed when a button is pressed but the
   *   associated data is no longer available (e.g., expired or deleted). Returns an optional
   *   string if you want to display a specific alert to the user.
   * @returns A function that, given data of type T, returns a Promise resolving to an InlineKeyboard.
   */
  create<T>(
    id: string,
    items: Array<
      Array<{
        text: string
        cb: Callback<T, C>
      }>
    >,
    onExpiredButtonPress?: Callback<null, C>
  ): (data: T) => Promise<InlineKeyboard> {
    const hash = nanohash(id, CONSTANTS.hashLen)
    if (this.menus.has(hash)) {
      // not the best solution, but it works
      throw new Error(`[MenuGen] Menu with id ${id} already exists`)
    }

    const menu = new Menu<T, C>(hash, items, onExpiredButtonPress)
    this.menus.set(hash, menu as Menu<unknown>)
    return (data: T) => menu.generateKeyboard(data)
  }

  middleware() {
    return this.composer.middleware()
  }
}
