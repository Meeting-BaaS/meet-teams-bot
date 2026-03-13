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
        // Convert protobuf timestamp to ISO 8601 string
        // Meet timestamps can be microseconds, milliseconds, or seconds
        const rawTs = typeof msg.timestamp === "string" ? Number.parseInt(msg.timestamp, 10) : msg.timestamp
        let tsMillis: number
        if (rawTs > 1e15) {
          tsMillis = Math.floor(rawTs / 1000) // microseconds → milliseconds
        } else if (rawTs > 1e12) {
          tsMillis = rawTs // already milliseconds
        } else {
          tsMillis = rawTs * 1000 // seconds → milliseconds
        }
        await ChatManager.getInstance().handleChatMessage({
          messageId: msg.messageId,
          text: msg.text,
          senderName: msg.senderName || "Unknown",
          senderId: null, // Resolved by ChatManager via deviceId lookup
          deviceId: msg.deviceId,
          timestamp: new Date(tsMillis).toISOString(),
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
