import { dehumanize } from "../../utils/dehumanize"
import { logHumanInputTelemetrySummary } from "../../utils/human-input"
import { notifyJoinReady } from "../../branding"
import { Events } from "../../events"
import { setDirectMode } from "../../proxy/toggle-proxy"
import { ScreenRecorderManager } from "../../recording/ScreenRecorder"
import { HtmlSnapshotService } from "../../services/html-snapshot-service"
import { GLOBAL } from "../../singleton"
import { Streaming } from "../../streaming"
import { formatError } from "../../utils/Logger"
import { handleTimingControl } from "../../utils/timing-control"

import { MeetingEndReason, MeetingStateType, type StateExecuteResult } from "../types"
import { BaseState } from "./base-state"
import { loginToGoogleMeetWithSso, MeetSsoLoginError } from "./google-meet-sso-login"

export class WaitingRoomState extends BaseState {
  async execute(): StateExecuteResult {
    try {
      console.info("Entering waiting room state")

      // Get meeting information
      const { meetingId, password } = await this.getMeetingInfo()
      console.info("Meeting info retrieved", {
        meetingId,
        hasPassword: !!password
      })

      // Generate the meeting link
      const meetingLink = this.context.provider.getMeetingLink(
        meetingId,
        password,
        0,
        GLOBAL.get().bot_name,
        GLOBAL.get().entry_message
      )

      // Initialize streaming service BEFORE opening meeting page
      // so that Teams/Meet can detect it and enable audio capture.
      // Output-only, input-only, and bidirectional streaming are all supported;
      // input-only must still construct Streaming so the bot connects to input_url.
      const streamingOut = GLOBAL.get().streaming_output
      const streamingIn = GLOBAL.get().streaming_input
      if (streamingOut || streamingIn) {
        this.context.streamingService = new Streaming(
          streamingIn,
          streamingOut,
          GLOBAL.get().streaming_audio_frequency,
          GLOBAL.get().bot_uuid
        )
      }

      // Authenticated Meet bot: sign in via SAML SSO BEFORE opening the meeting page.
      // Google auth cookies set on the browser context persist for the meet.google.com
      // navigation that follows.
      const ssoConfig = GLOBAL.get().meet_sso_config
      const isMeet = GLOBAL.get().meeting_platform === "meet"
      if (isMeet && ssoConfig) {
        if (!this.context.browserContext) {
          throw new Error("Browser context not initialized for SSO login")
        }
        try {
          await loginToGoogleMeetWithSso(this.context.browserContext, ssoConfig)
        } catch (err) {
          if (err instanceof MeetSsoLoginError) {
            if (ssoConfig.fallback === "anonymous") {
              console.warn(
                `[meet-sso] login failed (${err.code}): ${err.message}. Falling back to anonymous join.`
              )
              GLOBAL.clearMeetSsoConfig()
              // Continue — openMeetingPage runs next as an unauthenticated bot.
            } else {
              console.error(
                `[meet-sso] login failed (${err.code}): ${err.message}. Reporting failure to api-server.`
              )
              const reason =
                err.code === "MEET_LOGIN_FAILED_SAML_REJECTED"
                  ? MeetingEndReason.MeetLoginFailedSamlRejected
                  : MeetingEndReason.MeetLoginFailedTimeout
              GLOBAL.setError(reason)
              throw err
            }
          } else {
            throw err
          }
        }
      }

      // Open the meeting page
      await this.openMeetingPage(meetingLink)

      // Start Pulse → output WebSocket capture only when output streaming is enabled.
      // Input-only bots still need Streaming (for input WebSocket) but must not run FFmpeg capture.
      if (this.context.streamingService && GLOBAL.get().streaming_output) {
        this.context.streamingService.startAudioCapture()
      }

      // Signal that the meeting page is open and the platform has confirmed
      // the camera works. If multi-image branding was deferred, this triggers
      // the switch from warmup placeholder to real branding.
      notifyJoinReady()

      // Start the dialog observer immediately after page is opened
      // This ensures it can start monitoring dialogs right away
      this.startDialogObserver()

      // Capture DOM state after meeting page is opened (void to avoid blocking)
      if (this.context.playwrightPage) {
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        void htmlSnapshot.captureSnapshot(this.context.playwrightPage, "waiting_room_page_opened")
      }

      ScreenRecorderManager.getInstance().startRecording(this.context.playwrightPage)

      // Send waiting room event after the page is open
      Events.inWaitingRoom()

      // Wait for acceptance into the meeting
      await this.waitForAcceptance()
      console.info("Successfully joined meeting")

      // If everything is fine, move to the InCall state
      return this.transition(MeetingStateType.InCall)
    } catch (error) {
      console.error("Error in waiting room state:", formatError(error))

      // Handle specific error types based on MeetingEndReason
      const endReason = GLOBAL.getEndReason()
      if (endReason) {
        switch (endReason) {
          case MeetingEndReason.BotNotAccepted:
            Events.botRejected()
            return this.handleError(error as Error)
          case MeetingEndReason.TimeoutWaitingToStart:
            Events.waitingRoomTimeout()
            return this.handleError(error as Error)
          case MeetingEndReason.ApiRequest:
            Events.apiRequestStop()
            return this.handleError(error as Error)
          case MeetingEndReason.ExitingMeetingBeforeRecord:
            return this.handleError(error as Error)
        }
      }

      return this.handleError(error as Error)
    }
  }

  private async getMeetingInfo() {
    if (!this.context.browserContext) {
      throw new Error("Browser context not initialized")
    }

    try {
      const meetingInfo = await this.context.provider.parseMeetingUrl(GLOBAL.get().meeting_url)
      // Store the transformed meeting URL in GLOBAL for later use (e.g., in API calls)
      GLOBAL.setTransformedMeetingUrl(meetingInfo.meetingId)
      return meetingInfo
    } catch (error) {
      console.error("Failed to parse meeting URL:", formatError(error))
      GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
      throw new Error("Failed to parse meeting URL")
    }
  }

  private async openMeetingPage(meetingLink: string) {
    if (!this.context.browserContext) {
      throw new Error("Browser context not initialized")
    }

    try {
      console.info("Attempting to open meeting page:", meetingLink)
      this.context.playwrightPage = await this.context.provider.openMeetingPage(
        this.context.browserContext,
        meetingLink,
        GLOBAL.get().streaming_input
      )
      // Page logger is already set up in openMeetingPage() before page.goto()
      // so we can see logs from init scripts. BaseState.setupPageLoggers() runs
      // too early (page doesn't exist yet) and would miss init script logs.
      console.info("Meeting page opened successfully")
    } catch (error) {
      console.error("Failed to open meeting page:", formatError(error))

      throw new Error(error instanceof Error ? error.message : "Failed to open meeting page")
    }
  }

  private async waitForAcceptance(): Promise<void> {
    if (!this.context.playwrightPage) {
      throw new Error("Meeting page not initialized")
    }

    // Run the slow, humanised pre-join interactions (dismiss dialogs, type bot
    // name, toggle mic/cam) BEFORE the scheduled-time wait below, so that at
    // start_time only the quick "Join now" click remains. Humanisation can add
    // tens of seconds; doing it here absorbs that into the bot's early window and
    // keeps scheduled bots joining on time. Runs before the waiting-room timeout
    // is armed, so it can't trip it. No-op for providers without prepareJoin
    // (Teams/Zoom).
    if (this.context.provider.prepareJoin) {
      await this.context.provider.prepareJoin(
        this.context.playwrightPage,
        () =>
          GLOBAL.getEndReason() === MeetingEndReason.ApiRequest ||
          GLOBAL.getEndReason() === MeetingEndReason.ExitingMeetingBeforeRecord
      )
    }

    // Handle timing control for precise meeting join times.
    // While waiting, poll the page URL to detect if Google Meet denied/redirected
    // (e.g. "You can't join this video call" → auto-redirect to workspace.google.com).
    // Only check for Meet — Teams URLs are on a different domain and would false-positive.
    const isMeet = GLOBAL.get().meeting_platform === "meet"
    const startTime = await handleTimingControl(GLOBAL.get().start_time, isMeet ? async () => {
      const url = this.context.playwrightPage?.url() ?? ""
      if (url && !url.includes("meet.google.com")) {
        console.log(`Page navigated away from Meet during timing wait: ${url}`)
        GLOBAL.setShouldRetry(true)
        GLOBAL.setError(
          MeetingEndReason.BotNotAccepted,
          "Google Meet denied entry - page redirected during scheduled wait"
        )
        return true
      }
      return false
    } : undefined)

    // If the abort check detected a denial during the wait, bail out immediately
    if (GLOBAL.getEndReason() === MeetingEndReason.BotNotAccepted) {
      throw new Error("Bot denied during timing control wait")
    }

    // Store the actual start time for later use - It is sent to the backend at the end of the meeting
    GLOBAL.setStartTime(startTime)

    const timeoutMs = GLOBAL.get().waiting_room_timeout * 1000
    console.info(`Setting waiting room timeout to ${timeoutMs}ms`)

    let joinSuccessful = false // Flag indicating we joined the meeting

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!joinSuccessful) {
          // Trigger the timeout only if we are not in the meeting
          GLOBAL.setError(MeetingEndReason.TimeoutWaitingToStart)
          const timeoutError = new Error("Waiting room timeout reached")
          console.error("Waiting room timeout reached", timeoutError)
          reject(timeoutError)
        }
      }, timeoutMs)

      const checkStopSignal = setInterval(() => {
        if (
          GLOBAL.getEndReason() === MeetingEndReason.ApiRequest ||
          GLOBAL.getEndReason() === MeetingEndReason.LoginRequired ||
          GLOBAL.getEndReason() === MeetingEndReason.ExitingMeetingBeforeRecord
        ) {
          clearInterval(checkStopSignal)
          clearTimeout(timeout)
          reject()
        }
      }, 1000)

      this.context.provider
        .joinMeeting(
          this.context.playwrightPage,
          () =>
            GLOBAL.getEndReason() === MeetingEndReason.ApiRequest ||
            GLOBAL.getEndReason() === MeetingEndReason.ExitingMeetingBeforeRecord,
          // Add a callback to notify that the join succeeded
          () => {
            joinSuccessful = true
            console.log("Join successful notification received")
            // Disable humanize immediately (Meet only — Teams is never humanized).
            if (this.context.playwrightPage && GLOBAL.get().meeting_platform === "meet") {
              // One greppable line summarising how the humanised join dispatched
              // (X11 vs CDP fallback rate) before we tear the humanised path down.
              logHumanInputTelemetrySummary()
              dehumanize(this.context.playwrightPage)
            }
            setDirectMode()
          },
          this.context.dialogObserver
        )
        .then(() => {
          clearInterval(checkStopSignal)
          clearTimeout(timeout)
          resolve()
        })
        .catch((error) => {
          clearInterval(checkStopSignal)
          clearTimeout(timeout)
          reject(error)
        })
    })
  }

  private startDialogObserver() {
    // Use the global observer instead of creating a local one
    // Stopping the dialog observer is done in the cleanup state
    if (this.context.dialogObserver) {
      console.info(`Starting global dialog observer in state ${this.constructor.name}`)
      this.context.dialogObserver.setupGlobalDialogObserver()
    } else {
      console.warn(`Global dialog observer not available in state ${this.constructor.name}`)
    }
  }
}
