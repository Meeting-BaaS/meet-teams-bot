import { envVars } from "../config/env-vars"
import type { MeetBotDetectionSignal } from "../meeting/meet/network-interception"
import { getProxyTelemetry } from "../proxy/toggle-proxy"
import { GLOBAL } from "../singleton"
import { getErrorMessageFromCode, type MeetingEndReason } from "../state-machine/types"
import axios from "./axios-instance"

export class Api {
  public static instance: Api | null = null // Singleton class

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

  // Handle end meeting with retry logic
  public async handleEndMeetingWithRetry(): Promise<void> {
    if (GLOBAL.isServerless()) {
      console.log("Skipping endMeetingTrampoline - serverless mode")
      return
    }

    try {
      await this.endMeetingTrampoline()
      console.log("API call to endMeetingTrampoline succeeded")
    } catch (error) {
      console.warn(
        "API call to endMeetingTrampoline failed (continuing execution):",
        error instanceof Error ? error.message : error
      )
      // Don't throw - continue execution even if API call fails
    }
  }
}
