import { dehumanize } from "../../utils/dehumanize"
import { notifyJoinReady } from "../../branding"
import {
  establishBrowserSession,
  teardownBrowserSession
} from "../../browser/browser-session"
import { envVars } from "../../config/env-vars"
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

      // Open the page and wait for admission, with bounded in-process retries on
      // Zoom's IP-keyed anti-bot wall (relaunch on a fresh exit IP in this warm
      // pod before the SQS requeue). Non-Zoom platforms run exactly one attempt.
      await this.joinWithInProcessRetry(meetingLink)
      console.info("Successfully joined meeting")

      // If everything is fine, move to the InCall state
      return this.transition(MeetingStateType.InCall)
    } catch (error) {
      console.error("Error in waiting room state:", formatError(error))

      // Handle specific error types based on MeetingEndReason
      const endReason = GLOBAL.getEndReason()

      // Zoom: mirror Meet/Teams — any failure while still trying to join is
      // retryable, because a fresh pod on a fresh exit IP can clear a transient
      // network/render error, the probabilistic anti-bot wall, or a denial. Only
      // the deterministic outcomes stay terminal. Scoped to Zoom so Meet/Teams
      // keep their own per-case retry logic; this catch runs only before InCall,
      // so an in-meeting failure can never wrongly requeue.
      if (GLOBAL.get().meeting_platform === "zoom") {
        const ZOOM_TERMINAL: MeetingEndReason[] = [
          MeetingEndReason.LoginRequired,
          MeetingEndReason.BotRemoved,
          MeetingEndReason.BotRemovedTooEarly,
          MeetingEndReason.InvalidMeetingUrl,
          MeetingEndReason.ApiRequest,
          MeetingEndReason.TimeoutWaitingToStart
        ]
        if (!endReason || !ZOOM_TERMINAL.includes(endReason)) {
          console.log(
            `[Zoom] Pre-join failure (${endReason ?? "unknown"}) — marking retryable (fresh pod/IP)`
          )
          GLOBAL.setShouldRetry(true)
        }
      }

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

  /**
   * Open the meeting page and wait for admission. On Zoom's IP-keyed anti-bot
   * wall (zoomAnonymousJoinNotAllowed) — and only that reason — relaunch the
   * browser on a fresh residential exit IP in THIS pod, up to
   * IN_PROCESS_RETRY_MAX times, before letting the failure propagate to the SQS
   * requeue (a genuinely fresh pod). Xvfb/PulseAudio/screen-recorder scaffolding
   * stays up across attempts; only the browser context + proxy session recycle.
   * The one-time, device/display-level side effects (audio capture, branding
   * switch, dialog observer, waiting-room webhook) run only on the first attempt.
   */
  private async joinWithInProcessRetry(meetingLink: string): Promise<void> {
    const isZoom = GLOBAL.get().meeting_platform === "zoom"
    const maxInProc = isZoom ? envVars.IN_PROCESS_RETRY_MAX : 0

    for (let attempt = 0; ; attempt++) {
      try {
        await this.openMeetingPage(meetingLink)

        if (attempt === 0) {
          // Pulse → output WebSocket capture (output streaming only). Device-level
          // and self-guarded, so it survives a browser relaunch — start it once.
          if (this.context.streamingService && GLOBAL.get().streaming_output) {
            this.context.streamingService.startAudioCapture()
          }
          // Branding switch (warmup placeholder → real image) — idempotent trigger.
          notifyJoinReady()
          // Dialog observer polls context.playwrightPage live, so wiring it once
          // picks up the relaunched page automatically (Meet-only; no-op on Zoom).
          this.startDialogObserver()
          // Waiting-room webhook — fire once, not per relaunch.
          Events.inWaitingRoom()
        }

        if (this.context.playwrightPage) {
          void HtmlSnapshotService.getInstance().captureSnapshot(
            this.context.playwrightPage,
            "waiting_room_page_opened"
          )
        }

        // x11grab captures the display, self-guards on isRecording (no-op after
        // the first attempt), so the recording spans the relaunch seamlessly.
        ScreenRecorderManager.getInstance().startRecording(this.context.playwrightPage)

        await this.waitForAcceptance()
        return
      } catch (error) {
        const reason = GLOBAL.getEndReason()
        // Only the IP-reputation wall is worth an in-process relaunch; every other
        // reason (invalid URL, host denial, passcode, timeout) is not IP-keyed and
        // must fall through to the outer catch → SQS requeue / terminal failure.
        const canInProcessRetry =
          attempt < maxInProc && reason === MeetingEndReason.ZoomAnonymousJoinNotAllowed
        if (!canInProcessRetry) throw error

        console.log(
          `[Zoom] Anti-bot wall (${reason}) — in-process retry ${attempt + 1}/${maxInProc} on a fresh exit IP`
        )
        // Wipe the wall's error/end-reason/retry flags so the cleared attempt
        // doesn't leak into the next join or the final wasRecordingSuccessful check.
        GLOBAL.resetErrorState()
        // Recycle browser + proxy onto a new Decodo session id (suffix "x<n>") →
        // a different residential exit IP for the next launch.
        await teardownBrowserSession(this.context)
        await establishBrowserSession(this.context, { sessionSuffix: `x${attempt + 1}` })
      }
    }
  }

  private async getMeetingInfo() {
    if (!this.context.browserContext) {
      throw new Error("Browser context not initialized")
    }

    try {
      const meetingInfo = await this.context.provider.parseMeetingUrl(GLOBAL.get().meeting_url)
      // transformed_meeting_url must be a valid URL — it goes out in webhooks/API
      // calls AND into the retry SQS message, whose consumer validates it with
      // url(). Meet/Teams parsers return a full URL as meetingId; Zoom returns a
      // bare numeric id, which fails that schema and silently kills the retry.
      // Fall back to the original meeting_url (always a valid URL) when the parsed
      // id isn't one, so every platform stores a URL here like Meet/Teams do.
      const meetingIdIsUrl = /^https?:\/\//i.test(meetingInfo.meetingId)
      GLOBAL.setTransformedMeetingUrl(
        meetingIdIsUrl ? meetingInfo.meetingId : GLOBAL.get().meeting_url
      )
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
            // Stop humanizing the moment we're admitted — restore native
            // Playwright speed for the in-call phase. Both Meet and Teams
            // humanize the join now; dehumanize() is a safe no-op if the page
            // was never humanized, so no platform gate is needed.
            if (this.context.playwrightPage) {
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
