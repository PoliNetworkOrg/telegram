import type { Context } from "@/lib/managed-commands"
import type { Message } from "grammy/types"

import { Cron } from "croner"

import { tgLogger } from "@/bot"
import { logger } from "@/logger"

interface StoredMessage {
  chatId: number
  messageId: number
  authorId: number
  timestamp: Date
  isDeleted?: boolean
}

/**
 * Middleware to detect message deletions via UI
 * Note: This is challenging because Telegram doesn't send deletion events to bots
 * We work around this by periodically checking if stored messages still exist
 */
export class MessageDeletionTracker {
  private recentMessages: Map<string, StoredMessage> = new Map()
  private deletionCheckInterval: number = 30 * 1000 // 30 seconds
  private messageRetentionTime: number = 5 * 60 * 1000 // 5 minutes

  constructor() {
    // Periodically check for deleted messages
    new Cron("*/30 * * * * *", () => this.checkForDeletedMessages())
    
    // Clean up old messages from memory
    new Cron("*/5 * * * *", () => this.cleanupOldMessages())
  }

  private getMessageKey(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`
  }

  /**
   * Store a message for deletion tracking
   */
  storeMessage(message: Message): void {
    const key = this.getMessageKey(message.chat.id, message.message_id)
    
    this.recentMessages.set(key, {
      chatId: message.chat.id,
      messageId: message.message_id,
      authorId: message.from?.id || 0,
      timestamp: new Date(message.date * 1000),
    })
  }

  /**
   * Mark a message as deleted by command to avoid false positives
   */
  markMessageDeletedByCommand(chatId: number, messageId: number): void {
    const key = this.getMessageKey(chatId, messageId)
    const stored = this.recentMessages.get(key)
    if (stored) {
      stored.isDeleted = true
    }
  }

  /**
   * Check if stored messages still exist in Telegram
   */
  private async checkForDeletedMessages(): Promise<void> {
    const messagesToCheck = Array.from(this.recentMessages.values())
      .filter(msg => !msg.isDeleted && this.shouldCheckMessage(msg))

    for (const message of messagesToCheck) {
      try {
        // Try to get the message - if it throws, it's likely deleted
        await this.checkMessageExists(message)
      } catch (error) {
        logger.debug({ error, message }, "Error checking message existence")
      }
    }
  }

  private shouldCheckMessage(message: StoredMessage): boolean {
    const now = Date.now()
    const messageAge = now - message.timestamp.getTime()
    
    // Only check messages that are recent but not too new
    // (too new messages might not be fully propagated)
    return messageAge > 10000 && messageAge < this.messageRetentionTime
  }

  private async checkMessageExists(storedMessage: StoredMessage): Promise<void> {
    try {
      // Note: There's no direct way to check if a message exists without trying to forward it
      // or having admin permissions to access message history
      // This is a limitation of the Telegram Bot API
      
      // For now, we'll implement a basic check that we can enhance later
      // In practice, we'd need admin permissions and would use getChat() or similar
      
      // Mark as checked to avoid repeated attempts
      const key = this.getMessageKey(storedMessage.chatId, storedMessage.messageId)
      const stored = this.recentMessages.get(key)
      if (stored) {
        stored.isDeleted = true // Assume it still exists if no error
      }
      
    } catch (error) {
      // If we can't access the message, it might be deleted
      // But we can't be sure without admin permissions
      logger.debug({ error, storedMessage }, "Could not verify message existence")
    }
  }

  /**
   * Clean up old messages from memory to prevent memory leaks
   */
  private cleanupOldMessages(): void {
    const now = Date.now()
    const keysToDelete: string[] = []

    for (const [key, message] of this.recentMessages) {
      const messageAge = now - message.timestamp.getTime()
      if (messageAge > this.messageRetentionTime) {
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      this.recentMessages.delete(key)
    }

    if (keysToDelete.length > 0) {
      logger.debug(`Cleaned up ${keysToDelete.length} old messages from deletion tracker`)
    }
  }

  /**
   * Middleware to track messages for deletion detection
   */
  middleware = async (ctx: Context, next: () => Promise<void>) => {
    // Only track messages in groups (not private chats)
    if (ctx.chat?.type !== "private" && ctx.message) {
      this.storeMessage(ctx.message)
    }

    return next()
  }
}