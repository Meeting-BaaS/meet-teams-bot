import { switchToRecordingBranding } from "../../branding"
import { ChatManager } from "../../chat-manager"
import { Events } from "../../events"
import { ChatObserver } from "../../meeting/chatObserver"
import { HtmlCleaner } from "../../meeting/htmlCleaner"

import { verifyMeetAudioCapture } from "../../meeting/meet/audio-capture"
import type { NetworkPayload, NetworkUser } from "../../meeting/meet/network-interception/types"
import { startUIBasedObserver } from "../../meeting/meet/ui-observer"
import { ScreenRecorderManager } from "../../recording/ScreenRecorder"
import { GLOBAL } from "../../singleton"
import { SpeakerManager } from "../../speaker-manager"
import { formatError } from "../../utils/Logger"
import { MEETING_CONSTANTS } from "../constants"
import { MeetingStateType, type StateExecuteResult } from "../types"
import { BaseState } from "./base-state"

export class InCallState extends BaseState {
  private isStartingUIObserver = false // Lock to prevent race conditions in fallback

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

    // Start chat observation (non-critical)
    try {
      await this.startChatObservation()
    } catch (error) {
      console.error("Failed to start chat observation:", formatError(error))
      // Continue even if chat observation fails
    }

    // Non-blocking: entry message and audio verification (Meet only)
    this.performNonBlockingActions().catch((err) => {
      console.error("Error in non-blocking actions:", formatError(err))
    })

    // Switch branding to recording image if bot_status mode
    if (GLOBAL.get().bot_image_config?.loop_mode === "bot_status") {
      switchToRecordingBranding()
    }

    // Notify that recording has started
    Events.inCallRecording({ start_time: this.context.startTime })
  }

  /**
   * Non-blocking actions after critical setup: entry message (all platforms), audio verification (Meet only).
   */
  private async performNonBlockingActions(): Promise<void> {
    if (!this.context.playwrightPage) return

    const platform = GLOBAL.get().meeting_platform

    // Meet-specific: verify audio capture
    if (platform === "meet" && GLOBAL.get().streaming_output) {
      try {
        await verifyMeetAudioCapture(this.context.playwrightPage)
      } catch (error) {
        console.error("[Meet] Failed to verify audio capture post-join:", formatError(error))
      }
    }

    // Entry message: works for both Meet and Teams via ChatManager
    if (GLOBAL.get().entry_message) {
      console.log(`Sending entry message via ChatManager (non-blocking, platform=${platform})...`)
      ChatManager.getInstance()
        .sendBotMessage(
          this.context.playwrightPage,
          platform,
          GLOBAL.get().entry_message,
          this.context.chatObserver,
        )
        .then((result) => {
          if (result.success) {
            console.log("[InCallState] Entry message sent successfully")
          } else {
            console.error("[InCallState] Entry message failed:", (result as { error: string }).error)
          }
        })
        .catch((error) => {
          console.error("Failed to send entry message:", formatError(error))
        })
    }
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
    if (GLOBAL.get().meeting_platform === "meet" && !GLOBAL.hasNetworkInterceptionSetupFailed()) {
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
      const onNetworkSpeakersChange = async (payload: NetworkPayload) => {
        try {
          // Handle network interception failure - trigger UI Observer fallback
          if (payload.source === "network_interception_failed" && payload.failure) {
            const { trackId, reason, trackState } = payload.failure
            console.warn(
              `[NetworkInterceptor] ❌ Network interception failed for track ${trackId}: ${reason} (state: ${trackState})`
            )

            // Mark network interception as failed to prevent further attempts
            GLOBAL.setNetworkInterceptionSetupFailed()

            // Trigger UI Observer fallback (only if not already started or starting)
            if (!this.context.speakersObserver && !this.isStartingUIObserver) {
              this.isStartingUIObserver = true
              console.warn("[NetworkInterceptor] 🔄 Falling back to UI-based speaker detection")
              try {
                await this.startUIBasedObservation()
              } finally {
                this.isStartingUIObserver = false
              }
            } else {
              if (this.context.speakersObserver) {
                console.log("[NetworkInterceptor] ℹ️ UI Observer already running, skipping fallback")
              } else {
                console.log(
                  "[NetworkInterceptor] ℹ️ UI Observer fallback already in progress, skipping duplicate"
                )
              }
            }
            return // Don't process as speaker update
          }

          // Handle health check reports
          if (payload.source === "health_check" && payload.health) {
            const { subscribed, activeTrackCount, audioProcessingActive, subscriptionError } =
              payload.health

            if (subscriptionError) {
              console.warn(`[NetworkInterceptor] ⚠️ Health Check: ${subscriptionError}`)
            }

            if (!subscribed) {
              console.warn(
                "[NetworkInterceptor] ⚠️ Health Check: Not subscribed to audio track layer"
              )
            } else if (activeTrackCount === 0) {
              console.log(
                `[NetworkInterceptor] ℹ️ Health Check: Subscribed but no audio tracks detected yet (${activeTrackCount} tracks)`
              )
            } else {
              console.log(
                `[NetworkInterceptor] ✅ Health Check: Audio processing active (${activeTrackCount} track(s) being monitored)`
              )
            }

            // Log detailed health status at info level
            console.log(
              `[NetworkInterceptor] Health Status: subscribed=${subscribed}, tracks=${activeTrackCount}, processing=${audioProcessingActive}`
            )

            return // Don't process as speaker update
          }

          // Existing speaker update handling
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
      }
      console.warn("[NetworkInterceptor] ⚠️ Network interception setup returned false")
      return false
    } catch (error) {
      console.warn("[NetworkInterceptor] ⚠️ Network interception setup failed:", formatError(error))
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

    await startUIBasedObserver(this.context.playwrightPage, this.context)
  }

  private async startChatObservation(): Promise<void> {
    if (!this.context.playwrightPage) {
      console.error("Playwright page not available for chat observation")
      return
    }

    console.log(`Starting chat observation for ${GLOBAL.get().meeting_platform}`)

    ChatManager.start()

    const chatObserver = new ChatObserver(GLOBAL.get().meeting_platform)
    await chatObserver.startObserving(this.context.playwrightPage)
    this.context.chatObserver = chatObserver
    if (chatObserver.isChatDisabled()) {
      console.warn("[InCallState] Chat is disabled for this meeting")
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
