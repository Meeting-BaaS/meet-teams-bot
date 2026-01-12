import { Events } from "../../events"
import { HtmlCleaner } from "../../meeting/htmlCleaner"
import { findShowEveryOne } from "../../meeting/meet"
import { SpeakersObserver } from "../../meeting/speakersObserver"
import type { NetworkUser } from "../../meeting/meet/network-interception/types"
import { ScreenRecorderManager } from "../../recording/ScreenRecorder"
import { GLOBAL } from "../../singleton"
import { SpeakerManager } from "../../speaker-manager"
import type { SpeakerData } from "../../types"
import { formatError } from "../../utils/Logger"
import { MEETING_CONSTANTS } from "../constants"
import { MeetingStateType, type StateExecuteResult } from "../types"
import { BaseState } from "./base-state"

export class InCallState extends BaseState {
  async execute(): StateExecuteResult {
    const startTime = Date.now()
    console.info(`[InCallState] Starting execute() at ${new Date(startTime).toISOString()}`)

    try {
      // Start with global timeout for setup
      await Promise.race([this.setupRecording(), this.createTimeout()])

      const duration = Date.now() - startTime
      console.info(`[InCallState] Setup completed successfully in ${duration}ms`)
      return this.transition(MeetingStateType.Recording)
    } catch (error) {
      const duration = Date.now() - startTime
      console.error(`[InCallState] Setup recording failed after ${duration}ms`, formatError(error))
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
      console.error("Failed during recording setup:", formatError(error))
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
      console.error(
        "Error in setupBrowserComponents:",
        formatError(error, {
          hasPlaywrightPage: !!this.context.playwrightPage,
          recordingMode: GLOBAL.get().recording_mode,
          meetingPlatform: GLOBAL.get().meeting_platform,
          botName: GLOBAL.get().bot_name
        })
      )
      throw new Error(`Browser component setup failed: ${error as Error}`)
    }

    // Start speakers observation in all cases
    // Speakers observation is independent of video recording
    try {
      await this.startSpeakersObservation()
    } catch (error) {
      console.error("Failed to start speakers observation:", formatError(error))
      // Continue even if speakers observation fails
    }

    // Notify that recording has started
    Events.inCallRecording({ start_time: this.context.startTime })
  }

  private async startSpeakersObservation(): Promise<void> {
    console.log(`Starting speakers observation for ${GLOBAL.get().meeting_platform}`)

    // Start SpeakerManager
    SpeakerManager.start()

    if (!this.context.playwrightPage) {
      console.error("Playwright page not available for speakers observation")
      return
    }

    // For Google Meet, try network interception first (PRIMARY), fallback to UI-based (FALLBACK)
    // This needs to happen early so the callback is ready when audio tracks start being processed
    // Skip if scripts failed to load in openMeetingPage (no point retrying)
    if (
      GLOBAL.get().meeting_platform === "meet" &&
      !GLOBAL.hasNetworkInterceptionSetupFailed()
    ) {
      try {
        const networkSetupSuccess = await this.tryNetworkInterception()
        if (networkSetupSuccess) {
          console.log("✅ Network-based speaker detection enabled for Meet")
          return // Successfully set up network interception, no need for UI-based
        }
      } catch (error) {
        console.warn(
          "⚠️ Network interception callback setup failed, falling back to UI-based detection:",
          formatError(error)
        )
        // Continue to UI-based fallback
      }
    } else if (GLOBAL.hasNetworkInterceptionSetupFailed()) {
      console.log(
        "ℹ️ Network interception scripts failed to load earlier, skipping to UI-based detection"
      )
    }

    // Fallback to UI-based detection (for Teams or if network interception failed)
    await this.startUIBasedObservation()
  }

  /**
   * Try to setup network interception for Meet.
   * Returns true if successful, false otherwise (allows graceful fallback).
   */
  private async tryNetworkInterception(): Promise<boolean> {
    if (!this.context.playwrightPage) {
      return false
    }

    try {
      // Dynamic import to avoid loading network interception code for Teams
      const { setupNetworkInterceptionCallback } = await import(
        "../../meeting/meet/network-interception"
      )

      // Callback to handle network speaker updates
      const onNetworkSpeakersChange = async (payload: {
        users: unknown[]
        timestamp: number
        source: string
      }) => {
        try {
          // Convert network users to SpeakerData format
          const networkUsers = payload.users as NetworkUser[]
          await SpeakerManager.getInstance().handleNetworkSpeakerUpdate(
            networkUsers,
            payload.timestamp
          )
        } catch (error) {
          console.error("Error handling network speaker update:", formatError(error))
        }
      }

      // Setup the callback (scripts were already added in meet.ts before navigation)
      const success = await setupNetworkInterceptionCallback(
        this.context.playwrightPage,
        onNetworkSpeakersChange
      )

      if (success) {
        console.log("[NetworkInterceptor] ✅ Network interception enabled successfully")
        // Mark network diarization as active (defensive pattern: only sets if not already set)
        GLOBAL.setNetworkDiarizationActiveIfNotSet()
        return true
      } else {
        console.warn("[NetworkInterceptor] ⚠️ Network interception setup returned false")
        return false
      }
    } catch (error) {
      console.warn(
        "[NetworkInterceptor] ⚠️ Network interception setup failed:",
        formatError(error)
      )
      return false
    }
  }

  /**
   * Start UI-based speaker observation (fallback method).
   */
  private async startUIBasedObservation(): Promise<void> {
    if (!this.context.playwrightPage) {
      console.error("Playwright page not available for speakers observation")
      return
    }

    // For Meet, open People panel if needed (UI-based detection requires it)
    if (GLOBAL.get().meeting_platform === "meet" && GLOBAL.get().recording_mode !== "gallery_view") {
      try {
        console.log("[Meet] Opening People panel for UI-based speaker detection...")
        // Create a cancelCheck function that checks for global errors
        const cancelCheck = () => GLOBAL.getEndReason() !== null
        
        await findShowEveryOne(this.context.playwrightPage, true, cancelCheck)
        console.log("[Meet] ✅ People panel opened for UI-based detection")
      } catch (error) {
        console.warn(
          "[Meet] ⚠️ Failed to open People panel, UI-based detection may not work:",
          formatError(error)
        )
        // Continue anyway - the observer might still work
      }
    }

    // Create and start integrated speakers observer
    const speakersObserver = new SpeakersObserver(GLOBAL.get().meeting_platform)

    // Callback to handle speakers changes
    const onSpeakersChange = async (speakers: SpeakerData[]) => {
      try {
        await SpeakerManager.getInstance().handleSpeakerUpdate(speakers)
      } catch (error) {
        console.error("Error handling speaker update:", formatError(error))
      }
    }

    try {
      await speakersObserver.startObserving(
        this.context.playwrightPage,
        GLOBAL.get().recording_mode,
        GLOBAL.get().bot_name,
        onSpeakersChange
      )

      // Store the observer in context for cleanup later
      this.context.speakersObserver = speakersObserver

      console.log("✅ UI-based speakers observer started successfully")
    } catch (error) {
      console.error("Failed to start UI-based speakers observer:", error)
      throw error
    }
  }

  private async startHtmlCleaning(): Promise<void> {
    if (!this.context.playwrightPage) {
      console.error("Playwright page not available for HTML cleanup")
      return
    }

    console.log(`Starting HTML cleanup for ${GLOBAL.get().meeting_platform}`)

    try {
      // EXACT SAME LOGIC AS EXTENSION: Use centralized HtmlCleaner
      const htmlCleaner = new HtmlCleaner(
        this.context.playwrightPage,
        GLOBAL.get().meeting_platform,
        GLOBAL.get().recording_mode
      )

      await htmlCleaner.start()

      // Store for cleanup later
      this.context.htmlCleaner = htmlCleaner

      console.log("HTML cleanup started successfully")
    } catch (error) {
      console.error("Failed to start HTML cleanup:", formatError(error))
      // Continue even if HTML cleanup fails - it's not critical
    }
  }
}
