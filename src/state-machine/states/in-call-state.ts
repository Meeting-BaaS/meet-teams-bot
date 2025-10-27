import { Events } from "../../events"
import { HtmlCleaner } from "../../meeting/htmlCleaner"
import { SpeakersObserver } from "../../meeting/speakersObserver"
import { ScreenRecorderManager } from "../../recording/ScreenRecorder"
import { GLOBAL } from "../../singleton"
import { SpeakerManager } from "../../speaker-manager"
import type { SpeakerData } from "../../types"
import { MEETING_CONSTANTS } from "../constants"
import { MeetingStateType, type StateExecuteResult } from "../types"
import { BaseState } from "./base-state"

export class InCallState extends BaseState {
  async execute(): StateExecuteResult {
    try {
      // Start with global timeout for setup
      await Promise.race([this.setupRecording(), this.createTimeout()])
      return this.transition(MeetingStateType.Recording)
    } catch (error) {
      console.error("Setup recording failed:", error)
      return this.handleError(error as Error)
    }
  }

  private createTimeout(): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("Setup timeout: Recording sequence took too long"))
      }, MEETING_CONSTANTS.SETUP_TIMEOUT)
    })
  }

  private async setupRecording(): Promise<void> {
    try {
      console.info("Starting recording setup sequence")

      // Notifier qu'on est en appel mais pas encore en enregistrement
      Events.inCallNotRecording()

      // Initialize services
      await this.initializeServices()

      // Clean HTML and start observation
      await this.setupBrowserComponents()

      console.info("Recording setup completed successfully")
    } catch (error) {
      console.error("Failed during recording setup:", error)
      throw error
    }
  }

  private async initializeServices(): Promise<void> {
    console.info("Initializing services")

    if (!this.context.pathManager) {
      throw new Error("PathManager not initialized")
    }
    console.info("Services initialized successfully")
  }

  private async setupBrowserComponents(): Promise<void> {
    if (!this.context.playwrightPage) {
      throw new Error("Playwright page not initialized")
    }

    try {
      console.log("Setting up browser components with integrated HTML cleanup...")

      // fix: Set meeting start time BEFORE starting speakers observation
      // This prevents race condition where speakers are detected before startTime is set
      const startTime = Date.now()
      this.context.startTime = startTime
      ScreenRecorderManager.getInstance().setMeetingStartTime(startTime)
      console.log(`Meeting start time set to: ${startTime} (${new Date(startTime).toISOString()})`)

      // Start HTML cleanup first to clean the interface
      await this.startHtmlCleaning()
    } catch (error) {
      console.error("Error in setupBrowserComponents:", error)
      console.error("Context state:", {
        hasPlaywrightPage: !!this.context.playwrightPage,
        recordingMode: GLOBAL.get().recordingMode,
        meetingProvider: GLOBAL.get().meetingPlatform,
        botName: GLOBAL.get().botName
      })
      throw new Error(`Browser component setup failed: ${error as Error}`)
    }

    // Start speakers observation in all cases
    // Speakers observation is independent of video recording
    try {
      await this.startSpeakersObservation()
    } catch (error) {
      console.error("Failed to start speakers observation:", error)
      // Continue even if speakers observation fails
    }

    // Notify that recording has started
    Events.inCallRecording({ start_time: this.context.startTime })
  }

  private async startSpeakersObservation(): Promise<void> {
    console.log(`Starting speakers observation for ${GLOBAL.get().meetingPlatform}`)

    // Start SpeakerManager
    SpeakerManager.start()

    if (!this.context.playwrightPage) {
      console.error("Playwright page not available for speakers observation")
      return
    }

    // Create and start integrated speakers observer
    const speakersObserver = new SpeakersObserver(GLOBAL.get().meetingPlatform)

    // Callback to handle speakers changes
    const onSpeakersChange = async (speakers: SpeakerData[]) => {
      try {
        await SpeakerManager.getInstance().handleSpeakerUpdate(speakers)
      } catch (error) {
        console.error("Error handling speaker update:", error)
      }
    }

    try {
      await speakersObserver.startObserving(
        this.context.playwrightPage,
        GLOBAL.get().recordingMode,
        GLOBAL.get().botName,
        onSpeakersChange
      )

      // Store the observer in context for cleanup later
      this.context.speakersObserver = speakersObserver

      console.log("Integrated speakers observer started successfully")
    } catch (error) {
      console.error("Failed to start integrated speakers observer:", error)
      throw error
    }
  }

  private async startHtmlCleaning(): Promise<void> {
    if (!this.context.playwrightPage) {
      console.error("Playwright page not available for HTML cleanup")
      return
    }

    console.log(`Starting HTML cleanup for ${GLOBAL.get().meetingPlatform}`)

    try {
      // EXACT SAME LOGIC AS EXTENSION: Use centralized HtmlCleaner
      const htmlCleaner = new HtmlCleaner(
        this.context.playwrightPage,
        GLOBAL.get().meetingPlatform,
        GLOBAL.get().recordingMode
      )

      await htmlCleaner.start()

      // Store for cleanup later
      this.context.htmlCleaner = htmlCleaner

      console.log("HTML cleanup started successfully")
    } catch (error) {
      console.error("Failed to start HTML cleanup:", error)
      // Continue even if HTML cleanup fails - it's not critical
    }
  }
}
