import { Events } from "./events"
import type { ChatMessageData } from "./types"

export class ChatManager {
  private static instance: ChatManager | null = null
  private seenMessageIds: Set<string> = new Set()

  static getInstance(): ChatManager {
    if (!ChatManager.instance) {
      ChatManager.instance = new ChatManager()
    }
    return ChatManager.instance
  }

  static start(): void {
    ChatManager.getInstance()
    console.log("[ChatManager] Started")
  }

  async handleChatMessage(message: ChatMessageData): Promise<void> {
    // Dedup by messageId
    if (this.seenMessageIds.has(message.messageId)) return
    this.seenMessageIds.add(message.messageId)

    // Trim set if > 1000 to prevent unbounded growth
    if (this.seenMessageIds.size > 1000) {
      const iterator = this.seenMessageIds.values()
      for (let i = 0; i < 500; i++) {
        const result = iterator.next()
        if (!result.done) {
          this.seenMessageIds.delete(result.value)
        }
      }
    }

    console.log(
      `[ChatManager] Chat message from ${message.senderName}: "${message.text.substring(0, 50)}${message.text.length > 50 ? "..." : ""}"`
    )

    // Fire webhook
    Events.chatMessageReceived({
      text: message.text,
      sender_name: message.senderName,
      timestamp: message.timestamp,
      message_id: message.messageId,
    })
  }
}
