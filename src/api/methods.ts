import { envVars } from "../config/env-vars"
import type { MeetBotDetectionSignal } from "../meeting/meet/network-interception"
import { getProxyTelemetry } from "../proxy/toggle-proxy"
import { GLOBAL } from "../singleton"
import { getErrorMessageFromCode, type MeetingEndReason } from "../state-machine/types"
import type { BotMetricsPayload } from "../services/metrics-collector"
import axios from "./axios-instance"

/**
 * Fetch the set of Google-Meet-"burned" exit ASNs (high flagged rate) from the
 * api-server. Used by the pre-join proxy rotation to avoid landing on a burned
 * network. Fail-soft: any error returns [] (avoid nothing) rather than blocking
 * the join.
 */
export async function fetchBurnedAsns(): Promise<number[]> {
  try {
    const resp = await axios.get("/bot-process/meet-burned-asns", { timeout: 5000 })
    const asns = (resp.data as { data?: { asns?: unknown } })?.data?.asns
    return Array.isArray(asns) ? asns.filter((n): n is number => typeof n === "number") : []
  } catch (error) {
    console.warn(
      "[BurnedAsns] fetch failed (avoiding nothing):",
      error instanceof Error ? error.message : error
    )
    return []
  }
}

export class Api {
  public static instance: Api | null = null // Singleton class

  /**
   * In-flight end-meeting report owned by the path that won
   * GLOBAL.claimEndMeetingReport(). A path that loses the claim awaits this
   * instead of returning immediately — otherwise the crash handler would
   * "skip the duplicate", fall through to process.exit(1), and kill the
   * owner's POST/backoff mid-flight.
   */
  private endMeetingReportPromise: Promise<boolean> | null = null

  constructor() {
    if (Api.instance instanceof Api) {
      console.error("Class is singleton, constructor cannot be called multiple times.")
      return
    }
    Api.instance = this
  }

  // Finalize bot structure into BDD and send webhook
  public async endMeetingTrampoline() {
    const startTime = GLOBAL.get().start_time || Math.floor(Date.now() / 1000)
    const exitTime = GLOBAL.get().exit_time || Math.floor(Date.now() / 1000)
    const extra = (GLOBAL.get().extra as Record<string, unknown> | null) ?? null
    const participants = GLOBAL.getParticipants()
    const speakers = GLOBAL.getSpeakers()
    const audioChunks = GLOBAL.getAudioChunks()
    const artifacts = GLOBAL.getArtifactKeys()

    const resp = await axios({
      method: "POST",
      url: "/bot-process/end-meeting-trampoline",
      // The shared instance retries network/5xx errors 3× (axios-instance.ts) —
      // stacked under handleEndMeetingWithRetry's own 3 attempts that would be
      // up to 12 sends of this non-idempotent POST. Retrying is owned by the
      // manual loop ONLY; disable the transport-level layer for this request.
      "axios-retry": { retries: 0 },
      params: {
        botId: GLOBAL.get().bot_id
      },
      data: {
        diarization_v2: false,
        bot_joined_at: startTime,
        bot_exited_at: exitTime,
        transformed_meeting_url: GLOBAL.get().transformed_meeting_url,
        participants,
        speakers,
        audioChunks,
        artifacts,
        extra
      }
    })
    return resp.data
  }

  public async notifyRecordingFailure(message?: string, errorCode?: string): Promise<void> {
    const code = errorCode || GLOBAL.getEndReason?.()
    const msg =
      message ||
      GLOBAL.getErrorMessage?.() ||
      (code ? getErrorMessageFromCode(code as MeetingEndReason) : "Unknown error")
    const extra = (GLOBAL.get().extra as Record<string, unknown> | null) ?? null

    try {
      await axios({
        method: "POST",
        url: "/bot-process/start-record-failed",
        data: {
          meeting_url: GLOBAL.get().meeting_url,
          transformed_meeting_url: GLOBAL.get().transformed_meeting_url,
          message: msg,
          ...(code && { error_code: code }),
          extra: extra
        },
        params: { botId: GLOBAL.get().bot_id }
      })
      console.log("Successfully notified backend of recording failure")
    } catch (error) {
      console.warn(
        "Unable to notify recording failure (continuing execution):",
        error instanceof Error ? error.message : error
      )
    }
  }

  /**
   * Lightweight check to see if a stop request has been issued for this bot.
   * Called on startup before joining the meeting.
   * Returns true if the bot should stop, false otherwise.
   * Failures are non-fatal — if the server is unreachable, returns false to let the bot proceed.
   */
  public async checkStopRequest(): Promise<boolean> {
    try {
      const resp = await axios({
        method: "GET",
        url: "/bot-process/check-stop-request",
        timeout: 10000,
        params: { bot_id: GLOBAL.get().bot_id }
      })
      const isStopped = resp.data?.is_stopped === true
      if (isStopped) {
        console.log(
          `Bot ${GLOBAL.get().bot_uuid} has a pending stop request — will not join meeting`
        )
      }
      return isStopped
    } catch (error) {
      console.warn(
        "check-stop-request failed (proceeding with join):",
        error instanceof Error ? error.message : error
      )
      return false
    }
  }

  public reportMeetBotDetection(signal: MeetBotDetectionSignal, pageAttempt: number): void {
    if (GLOBAL.isServerless()) {
      console.log("[MeetBotDetection] Serverless mode, skipping telemetry")
      return
    }

    const params = GLOBAL.get()
    const proxy = getProxyTelemetry()
    const runContext = {
      stack: "cloakbrowser_playwright",
      humanize: true,
      resolution: envVars.RESOLUTION,
      authenticated: Boolean(params.meet_sso_config),
      meet_sso_session_id_present: Boolean(params.meet_sso_config?.session_id),
      recording_mode: params.recording_mode,
      bot_image_loop_mode: params.bot_image_config?.loop_mode ?? null,
      streaming_input_enabled: Boolean(params.streaming_input),
      network_interception_setup_failed: GLOBAL.hasNetworkInterceptionSetupFailed(),
      proxy
    }

    axios({
      method: "POST",
      url: "/bot-process/meet-bot-detection",
      timeout: 5000,
      data: {
        bot_id: params.bot_id,
        bot_uuid: params.bot_uuid,
        detected_as_bot: signal.detectedAsBot,
        decoded: signal.decoded,
        raw_field: signal.rawField == null ? null : String(signal.rawField),
        detected_at: new Date(signal.timestamp).toISOString(),
        source: "create_meeting_device_response",
        retry_count: params.retry_count ?? 0,
        page_attempt: pageAttempt,
        proxy,
        run_context: runContext
      }
    })
      .then(() => {
        console.log(
          `[MeetBotDetection] Stored signal: detected=${signal.detectedAsBot}, decoded=${signal.decoded}, proxy_ip=${proxy.exit_ip ?? "none"}`
        )
      })
      .catch((error) => {
        console.warn(
          "[MeetBotDetection] Failed to store signal (continuing):",
          error instanceof Error ? error.message : error
        )
      })
  }

  public reportMetrics(payload: BotMetricsPayload): void {
    axios({
      method: "POST",
      url: "/bot-process/metrics",
      data: payload,
      "axios-retry": { retries: 0 },
      timeout: 5000
    }).catch((error) => {
      console.warn("Failed to report bot metrics (continuing):", error.message)
    })
  }

  // Handle end meeting with retry logic
  public async handleEndMeetingWithRetry(): Promise<void> {
    if (GLOBAL.isServerless()) {
      console.log("Skipping endMeetingTrampoline - serverless mode")
      return
    }

    // The trampoline is NOT idempotent server-side (it kicks off transcription
    // submission), so exactly one path may report it: the happy path or the
    // crash handler's finalized branch. A loser of the claim must NOT return
    // immediately — the crash handler would then exit(1) and kill the owner's
    // in-flight POST — so it awaits the owner's promise instead.
    if (!GLOBAL.claimEndMeetingReport()) {
      console.log("endMeetingTrampoline already owned by another path — awaiting it")
      if (this.endMeetingReportPromise) {
        const ownerSucceeded = await this.endMeetingReportPromise
        if (!ownerSucceeded) {
          // The owner exhausted its attempts and released the claim. This path
          // was already waiting to recover the report, so let it claim a fresh
          // bounded attempt set instead of returning and exiting the process.
          await this.handleEndMeetingWithRetry()
        }
      }
      return
    }
    // No await between the claim above and this assignment, so a losing path
    // always observes the promise (Node run-to-completion).
    this.endMeetingReportPromise = this.runEndMeetingAttempts()
    await this.endMeetingReportPromise
  }

  private async runEndMeetingAttempts(): Promise<boolean> {
    // A failed trampoline orphans the bot at recording_succeeded (the api-server
    // never learns artifacts/duration and never starts transcription), so retry
    // transient failures before giving up.
    const delaysMs = [0, 2000, 6000]
    for (let attempt = 1; attempt <= delaysMs.length; attempt++) {
      try {
        if (delaysMs[attempt - 1] > 0) {
          await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]))
        }
        await this.endMeetingTrampoline()
        console.log(`API call to endMeetingTrampoline succeeded (attempt ${attempt})`)
        return true
      } catch (error) {
        console.warn(
          `API call to endMeetingTrampoline failed (attempt ${attempt}/${delaysMs.length}):`,
          error instanceof Error ? error.message : error
        )
      }
    }
    // All attempts failed — clear the in-flight handle and release the claim so
    // a later path (e.g. the crash handler) can still try; continue execution
    // rather than throwing.
    this.endMeetingReportPromise = null
    GLOBAL.releaseEndMeetingReport()
    console.warn("endMeetingTrampoline exhausted all attempts (continuing execution)")
    return false
  }
}
