import { Composer, type Context, InlineKeyboard, type MiddlewareObj } from "grammy"
import { nanoid } from "nanoid"

import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { redis } from "@/redis"
import { nanohash } from "@/utils/crypto"

const CONSTANTS = {
  prefix: "menugen",
  maxRows: 100,
  maxCols: 12,
  hashLen: 16,
  padLen: 3,
}

type Callback<T> = (data: T) => void | Promise<void>

class Menu<T> {
  private dataStorage: RedisFallbackAdapter<T>
  private callbacks: Map<string, Callback<T>> = new Map()

  constructor(
    private hashedId: string,
    private items: Array<Array<{ text: string; cb: Callback<T> }>>
  ) {
    this.dataStorage = new RedisFallbackAdapter({
      redis,
      prefix: `menu-data:${this.hashedId}`,
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

  async call(row: number, col: number, keyboardId: string) {
    const buttonId = `${row}:${col}`
    const callback = this.callbacks.get(buttonId)
    if (!callback) throw new Error(`Callback not found for buttonId(row,col): ${buttonId}`)

    const data = await this.dataStorage.read(keyboardId)
    if (!data) throw new Error(`Data in redis not found for buttonId(row,col): ${buttonId}`)

    await callback(data)
    await this.dataStorage.delete(keyboardId)
  }
}

class MenuGenerator<C extends Context> implements MiddlewareObj<C> {
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

  constructor() {
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
        .call(row, col, keyboardId)
        .then(() => {
          ctx.answerCallbackQuery()
        })
        .catch((err) => {
          logger.error({ err }, "[MenuGen] Error handling menu callback")
          return next()
        })
    })
  }

  create<T>(id: string, items: Array<Array<{ text: string; cb: Callback<T> }>>): (data: T) => Promise<InlineKeyboard> {
    const hash = nanohash(id, CONSTANTS.hashLen)
    if (this.menus.has(hash)) {
      // not the best solution, but it works
      throw new Error(`[MenuGen] Menu with id ${id} already exists`)
    }

    const menu = new Menu<T>(hash, items)
    this.menus.set(hash, menu as Menu<unknown>)
    return (data: T) => menu.generateKeyboard(data)
  }

  middleware() {
    return this.composer.middleware()
  }
}

export const _menuGenerator = new MenuGenerator()
