import type { Page } from "@playwright/test"
import type { MeetingProvider } from "../types"
import { formatError } from "../utils/Logger"
import { MeetChatObserver } from "./meet/chatObserver"
import { TeamsChatObserver } from "./teams/chatObserver"

export class ChatObserver {
  private meetingProvider: MeetingProvider
  private observer: MeetChatObserver | TeamsChatObserver | null = null
  private isObserving = false

  constructor(meetingProvider: MeetingProvider) {
    this.meetingProvider = meetingProvider
  }

  public async startObserving(page: Page): Promise<void> {
    if (this.isObserving) {
      console.warn("[ChatObserver] Already running")
      return
    }

    console.log(`[ChatObserver] Starting for ${this.meetingProvider}...`)

    switch (this.meetingProvider) {
      case "meet":
        this.observer = new MeetChatObserver(page)
        break
      case "teams":
        this.observer = new TeamsChatObserver(page)
        break
      default:
        console.warn(`[ChatObserver] Unknown meeting provider: ${this.meetingProvider}`)
        return
    }

    try {
      await this.observer.startObserving()
      this.isObserving = true
      console.log(`[ChatObserver] ✅ Started for ${this.meetingProvider}`)
    } catch (error) {
      console.error(`[ChatObserver] Failed to start:`, formatError(error))
      this.observer = null
    }
  }

  public stopObserving(): void {
    if (!this.isObserving || !this.observer) return

    console.log(`[ChatObserver] Stopping for ${this.meetingProvider}...`)
    this.observer.stopObserving()
    this.observer = null
    this.isObserving = false
    console.log(`[ChatObserver] ✅ Stopped for ${this.meetingProvider}`)
  }

  public isCurrentlyObserving(): boolean {
    return this.isObserving
  }

  public isChatDisabled(): boolean {
    if (this.observer instanceof TeamsChatObserver) {
      return this.observer.chatDisabled
    }
    return false
  }
}
