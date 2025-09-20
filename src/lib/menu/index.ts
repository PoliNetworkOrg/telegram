import { Composer, type Context, InlineKeyboard, type MiddlewareObj } from "grammy"
import { nanoid } from "nanoid"

import { RedisFallbackAdapter } from "@/lib/redis-fallback-adapter"
import { logger } from "@/logger"
import { redis } from "@/redis"
import { nanohash } from "@/utils/crypto"

class Menu<T> {
  private dataStorage: RedisFallbackAdapter<T>
  private callbacks: Map<string, (data: T) => void> = new Map()

  constructor(
    private hashedID: string,
    private items: Array<Array<{ text: string; cb: (data: T) => void }>>
  ) {
    this.dataStorage = new RedisFallbackAdapter({
      redis,
      prefix: `menu-data:${this.hashedID}:`,
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
    const keyboardID = nanoid(16)
    await this.dataStorage.write(keyboardID, data)

    const keyboard = new InlineKeyboard()
    this.items.forEach((row, rowIndex) => {
      row.forEach((item, colIndex) => {
        keyboard.text(item.text, MenuGenerator.toCallbackID(this.hashedID, rowIndex, colIndex, keyboardID))
      })
      if (rowIndex < this.items.length - 1) keyboard.row()
    })
    return keyboard
  }

  async call(row: number, col: number, keyboardID: string) {
    const buttonId = `${row}:${col}`
    const callback = this.callbacks.get(buttonId)
    const data = await this.dataStorage.read(keyboardID)
    if (callback && data) {
      callback(data)
    } else {
      throw new Error(`Callback or data not found for ID: ${buttonId}`)
    }
  }
}

export class MenuGenerator<C extends Context> implements MiddlewareObj<C> {
  static toCallbackID(menuHash: string, row: number, col: number, keyboardID: string): string {
    const coords = `${row.toString().padStart(4, "0")}:${col.toString().padStart(4, "0")}`
    return `${menuHash}|${coords}|${keyboardID}`
  }

  static fromCallbackID(
    callbackData: string
  ): { menuHash: string; row: number; col: number; keyboardID: string } | null {
    const parts = callbackData.split("|")
    if (parts.length !== 3) return null
    const [menuHash, coords, keyboardID] = parts
    const [rowStr, colStr] = coords.split(":")
    if (!rowStr || !colStr) return null
    const row = parseInt(rowStr, 10)
    const col = parseInt(colStr, 10)
    if (Number.isNaN(row) || Number.isNaN(col)) return null
    return { menuHash, row, col, keyboardID }
  }

  private composer: Composer<C> = new Composer<C>()
  private menus: Map<string, Menu<unknown>> = new Map()

  constructor() {
    this.composer.on("callback_query:data", (ctx, next) => {
      // Handle callback query
      const callbackData = ctx.callbackQuery.data
      const parsed = MenuGenerator.fromCallbackID(callbackData)
      if (!parsed) return next()

      const { menuHash, row, col, keyboardID } = parsed
      const menu = this.menus.get(menuHash)
      if (!menu) return next()
      return menu.call(row, col, keyboardID).catch((err) => {
        logger.error({ err }, "Error handling menu callback")
        return next()
      })
    })
  }

  create<T>(
    id: string,
    items: Array<
      Array<{
        text: string
        cb: (data: T) => void
      }>
    >
  ): (data: T) => Promise<InlineKeyboard> {
    const hash = nanohash(id)
    if (this.menus.has(hash)) {
      throw new Error(`Menu with id ${id} already exists`)
    }

    const menu = new Menu<T>(hash, items)
    this.menus.set(hash, menu as Menu<unknown>)
    return (data: T) => menu.generateKeyboard(data)
  }

  middleware() {
    return this.composer.middleware()
  }
}
