import type { Page } from "@playwright/test"
import { ChatManager } from "../../chat-manager"
import type { ChatMessage } from "./network-interception/types"
import { setupChatMessageCallback } from "./network-interception"

export class MeetChatObserver {
  private page: Page
  private isObserving = false

  constructor(page: Page) {
    this.page = page
  }

  public async startObserving(): Promise<void> {
    if (this.isObserving) {
      console.warn("[MeetChatObserver] Already observing")
      return
    }

    const onChatMessage = async (msg: ChatMessage) => {
      try {
        // Use current time as timestamp — Meet's protobuf timestamp is an internal
        // sequence number, not a reliable Unix timestamp in any unit
        await ChatManager.getInstance().handleChatMessage({
          message_id: msg.messageId,
          text: msg.text,
          sender_name: msg.senderName || "Unknown",
          sender_id: null, // Resolved by ChatManager via _device_id lookup
          _device_id: msg.deviceId,
          timestamp: new Date().toISOString(),
        })
      } catch (error) {
        console.error("[MeetChatObserver] Error handling chat message:", error)
      }
    }

    const success = await setupChatMessageCallback(this.page, onChatMessage)
    if (success) {
      this.isObserving = true
      console.log("[MeetChatObserver] Chat observation started")
    } else {
      console.warn("[MeetChatObserver] Failed to setup chat callback")
    }
  }

  public stopObserving(): void {
    if (!this.isObserving) return
    this.isObserving = false
    console.log("[MeetChatObserver] Chat observation stopped")
  }
}
