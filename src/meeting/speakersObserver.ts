import type { Page } from "@playwright/test"
import type { MeetingProvider, RecordingMode, SpeakerData } from "../types"
import { formatError } from "../utils/Logger"
import { MeetSpeakersObserver } from "./meet/speakersObserver"
import { TeamsSpeakersObserver } from "./teams/speakersObserver"

export class SpeakersObserver {
  private meetingProvider: MeetingProvider
  private observer: MeetSpeakersObserver | TeamsSpeakersObserver | null = null
  private isObserving = false
  private retryCount = 0
  private maxRetries = 3

  constructor(meetingProvider: MeetingProvider) {
    this.meetingProvider = meetingProvider
  }

  public async startObserving(
    page: Page,
    recordingMode: RecordingMode,
    botName: string,
    onSpeakersChange: (speakers: SpeakerData[]) => void
  ): Promise<void> {
    if (this.isObserving) {
      console.warn("[SpeakersObserver] Already running")
      return
    }

    console.log(`[SpeakersObserver] Starting for ${this.meetingProvider}...`)

    // Create the appropriate observer based on meeting provider - SIMPLE ROUTING
    switch (this.meetingProvider) {
      case "meet":
        this.observer = new MeetSpeakersObserver(page, recordingMode, botName, onSpeakersChange)
        break

      case "teams":
        this.observer = new TeamsSpeakersObserver(page, recordingMode, botName, onSpeakersChange)
        break

      default:
        throw new Error(`Unknown meeting provider: ${this.meetingProvider}`)
    }

    if (this.observer) {
      try {
        await this.observer.startObserving()
        this.isObserving = true
        this.retryCount = 0
        console.log(`[SpeakersObserver] ✅ Started for ${this.meetingProvider}`)
      } catch (error) {
        console.warn(
          `[SpeakersObserver] Failed to initialize (attempt ${this.retryCount + 1}/${this.maxRetries}):`,
          formatError(error)
        )

        // Retry logic - same as before
        if (this.retryCount < this.maxRetries) {
          this.retryCount++
          setTimeout(() => {
            console.log(
              `[SpeakersObserver] Retrying (attempt ${this.retryCount}/${this.maxRetries})...`
            )
            this.startObserving(page, recordingMode, botName, onSpeakersChange)
          }, 5000)
        } else {
          console.error(`[SpeakersObserver] Max retries (${this.maxRetries}) reached. Giving up.`)
          this.isObserving = false
          this.observer = null
        }
      }
    }
  }

  public stopObserving(): void {
    if (!this.isObserving || !this.observer) {
      return
    }

    console.log(`[SpeakersObserver] Stopping for ${this.meetingProvider}...`)
    this.observer.stopObserving()
    this.observer = null
    this.isObserving = false
    this.retryCount = 0
    console.log(`[SpeakersObserver] ✅ Stopped for ${this.meetingProvider}`)
  }

  public isCurrentlyObserving(): boolean {
    return this.isObserving
  }
}
