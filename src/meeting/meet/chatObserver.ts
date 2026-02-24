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

    console.log("[MeetChatObserver] Starting chat observation...")

    const onChatMessage = async (msg: ChatMessage) => {
      try {
        await ChatManager.getInstance().handleChatMessage({
          messageId: msg.messageId,
          text: msg.text,
          senderName: msg.senderName || "Unknown",
          timestamp: typeof msg.timestamp === "string" ? Number.parseInt(msg.timestamp, 10) : msg.timestamp,
        })
      } catch (error) {
        console.error("[MeetChatObserver] Error handling chat message:", error)
      }
    }

    const success = await setupChatMessageCallback(this.page, onChatMessage)
    if (success) {
      this.isObserving = true
      console.log("[MeetChatObserver] ✅ Chat observation started")
    } else {
      console.warn("[MeetChatObserver] Failed to setup chat callback")
    }
  }

  public stopObserving(): void {
    if (!this.isObserving) return
    this.isObserving = false
    console.log("[MeetChatObserver] ✅ Chat observation stopped")
  }
}
