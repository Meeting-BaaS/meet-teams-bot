import type { Page } from "@playwright/test"
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
import { MeetingEndReason, MeetingStateType, type StateExecuteResult } from "../types"
import { BaseState } from "./base-state"

export class InCallState extends BaseState {
  private isStartingUIObserver = false // Lock to prevent race conditions in fallback
  // deviceId -> stable index, so logs can say which participant changed without
  // printing a name or id.
  private readonly maskedSpeakerIndices = new Map<string, number>()
  private lastNetworkSpeakingKey?: string // Dedup for network-speaker debug logging
  // Tracks that stopped delivering audio. Recorded for diagnostics only — the
  // diarization health monitor decides when the network path is beyond saving.
  private readonly failedNetworkTracks = new Set<string>()

  async execute(): StateExecuteResult {
    const startTime = Date.now()
    console.info(`[InCallState] Starting execute() at ${new Date(startTime).toISOString()}`)

    try {
      // Quick check: if stop was already requested before entering InCall, skip setup entirely
      if (GLOBAL.getEndReason() === MeetingEndReason.ExitingMeetingBeforeRecord) {
        console.info("[InCallState] Stop already requested — skipping setup")
        return this.handleError(new Error("Stop requested before recording setup"))
      }

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

    // Start speakers observation BEFORE HTML cleanup: the recording is trimmed to
    // startTime, so every second spent cleaning before the speaker signal is live
    // is speech transcribed with no diarization to name it — it surfaces as a
    // leading "Unknown" speaker run at the start of the transcript. The cleanup
    // is cosmetic and can wait; the speaker timeline cannot.
    try {
      await this.startSpeakersObservation()
    } catch (error) {
      console.error("Failed to start speakers observation:", formatError(error))
      // Continue even if speakers observation fails
    }

    // HTML cleanup after the speaker signal is live
    try {
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

    // Start chat observation + entry message (non-critical, non-blocking)
    // Chat panel opening on Teams can take up to 25s of retries — must not block SETUP_TIMEOUT.
    // Entry message is sent after chat observation is ready, so it benefits from the panel being open.
    this.startChatObservationAndEntryMessage().catch((err) => {
      console.error("Failed in chat observation/entry message:", formatError(err))
    })

    // Non-blocking: audio verification (Meet only)
    this.performNonBlockingActions().catch((err) => {
      console.error("Error in non-blocking actions:", formatError(err))
    })

    // Switch branding to recording image if bot_status mode
    if (GLOBAL.get().bot_image_config?.loop_mode === "bot_status") {
      switchToRecordingBranding()
    }

    // Final gate: if a stop request arrived during setup, bail out
    // before firing the recording event and transitioning to Recording state
    if (GLOBAL.getEndReason() === MeetingEndReason.ExitingMeetingBeforeRecord) {
      throw new Error("Stop requested during recording setup — exiting before record")
    }

    // Notify that recording has started
    Events.inCallRecording({ start_time: this.context.startTime })
  }

  /**
   * Non-blocking actions after critical setup: audio verification (Meet only).
   */
  private async performNonBlockingActions(): Promise<void> {
    if (!this.context.playwrightPage) return

    // Meet-specific: verify audio capture
    if (GLOBAL.get().meeting_platform === "meet" && GLOBAL.get().streaming_output) {
      try {
        await verifyMeetAudioCapture(this.context.playwrightPage)
      } catch (error) {
        console.error("[Meet] Failed to verify audio capture post-join:", formatError(error))
      }
    }
  }

  /**
   * Non-blocking: start chat observation, then send entry message once the observer is ready.
   * On Teams, the observer opens the chat panel (with retries), so the entry message
   * benefits from the panel already being open instead of racing to open it independently.
   */
  private async startChatObservationAndEntryMessage(): Promise<void> {
    if (!this.context.playwrightPage) {
      console.error("Playwright page not available for chat observation")
      return
    }

    const platform = GLOBAL.get().meeting_platform

    // Start chat observation
    try {
      console.log(`Starting chat observation for ${platform}`)
      ChatManager.start()

      const chatObserver = new ChatObserver(platform)
      await chatObserver.startObserving(this.context.playwrightPage)
      this.context.chatObserver = chatObserver
      if (chatObserver.isChatDisabled()) {
        console.warn("[InCallState] Chat is disabled for this meeting")
      }
    } catch (error) {
      console.error("Failed to start chat observation:", formatError(error))
      // Continue to entry message attempt even if observation setup failed
    }

    // Send entry message after chat observation is ready
    if (GLOBAL.get().entry_message && this.context.playwrightPage) {
      console.log(`Sending entry message via ChatManager (platform=${platform})...`)
      try {
        const result = await ChatManager.getInstance().sendBotMessage(
          this.context.playwrightPage,
          platform,
          GLOBAL.get().entry_message,
          this.context.chatObserver,
        )
        if (result.success) {
          console.log("[InCallState] Entry message sent successfully")
        } else {
          console.error("[InCallState] Entry message failed:", (result as { error: string }).error)
        }
      } catch (error) {
        console.error("Failed to send entry message:", formatError(error))
      }
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

    // Meet, Teams and Zoom: try network interception first (PRIMARY), else UI-based.
    // Done early so the callback is ready when audio tracks start; skip if scripts
    // failed to load in openMeetingPage.
    const platform = GLOBAL.get().meeting_platform
    const networkCapablePlatform =
      platform === "meet" || platform === "teams" || platform === "zoom"
    if (networkCapablePlatform && !GLOBAL.hasNetworkInterceptionSetupFailed()) {
      try {
        const networkSetupSuccess = await this.tryNetworkInterception()
        if (networkSetupSuccess) {
          console.log(`✅ Network-based speaker detection enabled for ${platform}`)

          // Meet: also start the UI observer as an early-window BRIDGE. At first
          // speech after silence the speaker's audio track takes seconds to spin
          // up before the network path can attribute anything, while Meet's UI
          // indicator fires almost immediately — prod transcripts showed a
          // median 5.3s attribution hole exactly in that gap (leading "Unknown").
          // The SpeakerManager arbiter mutes this source once the network path
          // reports its first speaker. Non-blocking: opening the People panel
          // can take seconds and must not delay the recording-started event.
          if (platform === "meet" && this.context.playwrightPage) {
            this.startUIBasedObservation().catch((error) => {
              console.warn(
                "[SpeakerBridge] UI bridge failed to start (network path still active):",
                formatError(error)
              )
            })
          }
          return // Network interception is the primary source
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
   * Try to setup network interception for the current platform (Meet or Teams).
   * Returns true if successful, false otherwise (allows graceful fallback).
   */
  private async tryNetworkInterception(): Promise<boolean> {
    if (!this.context.playwrightPage) {
      return false
    }

    try {
      // Load only the platform's module. Both expose the same
      // (page, onSpeakersChange) signature, so the handler below is shared.
      const platform = GLOBAL.get().meeting_platform
      let setupNetworkInterceptionCallback: (
        page: Page,
        cb: (payload: NetworkPayload) => void
      ) => Promise<boolean>
      let verifyNetworkInterception: ((page: Page) => Promise<boolean>) | undefined

      if (platform === "teams") {
        const teamsNetworkInterception = await import("../../meeting/teams/network-interception")
        setupNetworkInterceptionCallback =
          teamsNetworkInterception.setupTeamsNetworkInterceptionCallback
        verifyNetworkInterception = teamsNetworkInterception.verifyTeamsNetworkInterception
      } else if (platform === "zoom") {
        const zoomNetworkInterception = await import("../../meeting/zoom/network-interception")
        setupNetworkInterceptionCallback =
          zoomNetworkInterception.setupZoomNetworkInterceptionCallback
        verifyNetworkInterception = zoomNetworkInterception.verifyZoomNetworkInterception
      } else {
        const meetNetworkInterception = await import("../../meeting/meet/network-interception")
        setupNetworkInterceptionCallback = meetNetworkInterception.setupNetworkInterceptionCallback
        verifyNetworkInterception = meetNetworkInterception.verifyNetworkInterception
      }

      // Callback to handle network speaker updates
      const onNetworkSpeakersChange = async (payload: NetworkPayload) => {
        try {
          // Handle network interception failure - trigger UI Observer fallback
          if (payload.source === "network_interception_failed" && payload.failure) {
            const { trackId, reason, trackState } = payload.failure
            this.failedNetworkTracks.add(trackId)
            console.warn(
              `[NetworkInterceptor] ❌ Network interception failed for track ${trackId}: ${reason} (state: ${trackState}) — ${this.failedNetworkTracks.size} track(s) failed so far`
            )

            // One dead track is not a dead pipeline. A participant who leaves,
            // reconnects or replaces their audio track takes their track down
            // with them; retiring the whole network path on the first such
            // event handed the rest of the meeting to the UI observer even
            // though the remaining tracks were still delivering audio.
            //
            // The stale-diarization monitor in RecordingState owns the fallback
            // decision: it falls back within ~10s of sound activity when the
            // network path has never produced a segment, which is both faster
            // and better evidenced than reacting to a single track.
            console.log(
              "[NetworkInterceptor] ℹ️ Keeping network path active — diarization health monitor owns the fallback decision"
            )
            return // Don't process as speaker update
          }

          // Datachannel speaking-signal probe: is the channel alive on this
          // session, and which undecoded varint field toggles with speech?
          if (payload.source === "dc_probe" && payload.dc) {
            const d = payload.dc
            const c = d.corr
            const corrStr = c
              ? ` corr(field9vsCsrc): onLoud=${c.onLoud} onQuiet=${c.onQuiet} offLoud=${c.offLoud} offQuiet=${c.offQuiet} samples=${c.samples}`
              : ""
            const levelsStr = d.levels?.length ? ` levels=[${d.levels.join(",")}]` : ""
            console.log(
              `[DcProbe] messages=${d.messages} bytes=${d.bytes} ` +
                `distinctPaths=${d.distinctPaths} toggling=[${d.toggling.join(",")}]${levelsStr}${corrStr}`
            )
            return
          }

          // Media-architecture probe: where does Meet run its media stack in
          // this session? One line per 30s per frame, static names only.
          if (payload.source === "media_probe" && payload.media) {
            const m = payload.media
            console.log(
              `[MediaProbe] frame=${m.frame} pc=${m.pcCreated} ` +
                `workers=[${m.workers.join(",")}] sharedWorkers=${m.sharedWorkers} ` +
                `webTransport=[${m.webTransport.join(",")}] scriptTransforms=${m.scriptTransforms} ` +
                `trackGenerators=${m.trackGenerators} audioContexts=${m.audioContexts} ` +
                `worklets=[${m.workletModules.join(",")}] ` +
                `workletNodes=[${(m.workletNodes ?? []).join(",")}] ` +
                `workletEdges=[${(m.workletEdges ?? []).join(",")}] ` +
                `mediaEls=${m.mediaEls}/${m.elsWithStream} liveAudioTracks=${m.liveAudioTracks}`
            )
            return // Not a speaker update
          }

          // CSRC audio-level probe: forward the browser-side summary into the
          // bot log so it survives the pod. One line per 30s, counts only.
          if (payload.source === "csrc_probe" && payload.probe) {
            const p = payload.probe
            console.log(
              `[CsrcProbe] receivers=${p.receivers} meetCalls=${p.meetCalls} ` +
                `csrc=${p.csrcSources} csrcLvl=${p.csrcWithLevel} csrcMax=${p.csrcMax.toFixed(3)} ` +
                `ssrc=${p.ssrcSources} ssrcLvl=${p.ssrcWithLevel} ssrcMax=${p.ssrcMax.toFixed(3)} ` +
                `mapped=${p.mapped}`
            )
            return // Not a speaker update
          }

          // Handle health check reports
          if (payload.source === "health_check" && payload.health) {
            const {
              subscribed,
              activeTrackCount,
              registeredTrackCount,
              lastFrameAgeMs,
              audioProcessingActive,
              subscriptionError
            } = payload.health

            if (subscriptionError) {
              console.warn(`[NetworkInterceptor] ⚠️ Health Check: ${subscriptionError}`)
            }

            if (!subscribed) {
              console.warn(
                "[NetworkInterceptor] ⚠️ Health Check: Not subscribed to audio track layer"
              )
            } else if (activeTrackCount === 0 && (registeredTrackCount ?? 0) > 0) {
              // Registered but silent: tracks are registered for monitoring and
              // not one frame has come out of them. Whether a processor exists
              // yet is unknown from here — a muted track waits before one is
              // created. This is the state that used to be reported as healthy.
              console.warn(
                `[NetworkInterceptor] ⚠️ Health Check: ${registeredTrackCount} track(s) registered but none delivering audio frames`
              )
            } else if (activeTrackCount === 0) {
              console.log(
                "[NetworkInterceptor] ℹ️ Health Check: Subscribed but no audio tracks detected yet (0 tracks)"
              )
            } else {
              console.log(
                `[NetworkInterceptor] ✅ Health Check: Audio processing active (${activeTrackCount} track(s) delivering frames)`
              )
            }

            // Log detailed health status at info level
            console.log(
              `[NetworkInterceptor] Health Status: subscribed=${subscribed}, delivering=${activeTrackCount}, registered=${registeredTrackCount ?? "n/a"}, lastFrameAgeMs=${lastFrameAgeMs ?? "never"}, processing=${audioProcessingActive}`
            )

            return // Don't process as speaker update
          }

          // Existing speaker update handling
          const networkUsers = payload.users as NetworkUser[]

          // Confirms diarization is coming from the network path. Never log names or
          // ids here — this goes to the bot log and on to S3. Participants are
          // referred to by a stable per-meeting index instead.
          const speakingLabels = networkUsers
            .filter((u) => u.isSpeaking)
            .map((u) => `#${this.maskedSpeakerIndex(u.deviceId)}`)
          const speakingKey = speakingLabels.slice().sort().join("|")
          if (speakingKey !== this.lastNetworkSpeakingKey) {
            this.lastNetworkSpeakingKey = speakingKey
          }

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
        if (verifyNetworkInterception) {
          const verified = await verifyNetworkInterception(this.context.playwrightPage)
          if (!verified) {
            console.warn("[NetworkInterceptor] ⚠️ Browser interceptor verification failed")
            return false
          }
        }

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
  /** Non-PII label for a participant, in first-seen order. */
  private maskedSpeakerIndex(deviceId: string): number {
    const existing = this.maskedSpeakerIndices.get(deviceId)
    if (existing !== undefined) return existing
    const next = this.maskedSpeakerIndices.size + 1
    this.maskedSpeakerIndices.set(deviceId, next)
    return next
  }

  private async startUIBasedObservation(): Promise<void> {
    if (!this.context.playwrightPage) {
      console.error("Playwright page not available for speakers observation")
      return
    }

    await startUIBasedObserver(this.context.playwrightPage, this.context)
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
