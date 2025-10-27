import type { Page } from "@playwright/test"
import type { MeetingProvider, RecordingMode } from "../types"
import { MeetHtmlCleaner } from "./meet/htmlCleaner"
import { TeamsHtmlCleaner } from "./teams/htmlCleaner"

export class HtmlCleaner {
  private meetingProvider: MeetingProvider
  private cleaner: MeetHtmlCleaner | TeamsHtmlCleaner | null = null
  private isRunning = false

  constructor(page: Page, meetingProvider: MeetingProvider, recordingMode: RecordingMode) {
    this.meetingProvider = meetingProvider

    // Create the appropriate cleaner based on meeting provider
    switch (this.meetingProvider) {
      case "meet":
        this.cleaner = new MeetHtmlCleaner(page, recordingMode)
        break

      case "teams":
        this.cleaner = new TeamsHtmlCleaner(page, recordingMode)
        break

      default:
        throw new Error(`Unknown meeting provider: ${this.meetingProvider}`)
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("HTML cleaner already running")
      return
    }

    console.log(`[HtmlCleaner] Starting for ${this.meetingProvider}...`)

    if (this.cleaner) {
      try {
        await this.cleaner.start()
        this.isRunning = true
        console.log(`[HtmlCleaner] ✅ Started for ${this.meetingProvider}`)
      } catch (error) {
        console.error(`Failed to start ${this.meetingProvider} HTML cleaner:`, error)
        throw error
      }
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning || !this.cleaner) {
      return
    }

    console.log(`[HtmlCleaner] Stopping for ${this.meetingProvider}...`)

    try {
      await this.cleaner.stop()
      this.isRunning = false
      console.log(`[HtmlCleaner] ✅ Stopped for ${this.meetingProvider}`)
    } catch (error) {
      console.error(`Failed to stop ${this.meetingProvider} HTML cleaner:`, error)
    }
  }

  public isCurrentlyRunning(): boolean {
    return this.isRunning
  }
}
