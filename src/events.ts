import axios from "./api/axios-instance"
import { envVars } from "./config/env-vars"
import { GLOBAL } from "./singleton"

export class Events {
  private static EVENTS: Events | null = null
  private sentEvents: Set<string> = new Set()

  static init() {
    if (GLOBAL.get().bot_uuid == null || GLOBAL.get().bot_id == null) return

    Events.EVENTS = new Events(GLOBAL.get().bot_uuid, GLOBAL.get().bot_id, GLOBAL.get().extra)
  }

  static async apiRequestStop() {
    return Events.EVENTS?.sendOnce("api_request_stop")
  }

  static async joiningCall() {
    return Events.EVENTS?.sendOnce("joining_call")
  }

  static async inWaitingRoom() {
    return Events.EVENTS?.sendOnce("in_waiting_room")
  }

  static async inCallNotRecording() {
    return Events.EVENTS?.sendOnce("in_call_not_recording")
  }

  static async inCallRecording(data: { start_time: number }) {
    return Events.EVENTS?.sendOnce("in_call_recording", data)
  }

  static async recordingPaused() {
    // Send webhook in parallel - don't wait for completion
    Events.EVENTS?.send("recording_paused")
  }

  static async recordingResumed() {
    // Send webhook in parallel - don't wait for completion
    Events.EVENTS?.send("recording_resumed")
  }

  static async callEnded() {
    return Events.EVENTS?.sendOnce("call_ended")
  }

  // Nouveaux événements pour les erreurs
  static async botRejected() {
    return Events.EVENTS?.sendOnce("bot_rejected")
  }

  static async botRemoved() {
    return Events.EVENTS?.sendOnce("bot_removed")
  }

  static async botRemovedTooEarly() {
    return Events.EVENTS?.sendOnce("bot_removed_too_early")
  }

  static async waitingRoomTimeout() {
    return Events.EVENTS?.sendOnce("waiting_room_timeout")
  }

  static async invalidMeetingUrl() {
    return Events.EVENTS?.sendOnce("invalid_meeting_url")
  }

  static async meetingError(error: Error) {
    return Events.EVENTS?.sendOnce("meeting_error", {
      error_message: error.message,
      error_type: error.constructor.name
    })
  }

  // Non-terminal retry event. Emitted when a failed attempt is being re-queued
  // to SQS for a fresh pod (fresh exit IP). Carries the attempt number and cap so
  // the dashboard can show "Retrying… (attempt N/max)" instead of flashing a
  // failure between attempts. A terminal recording_failed follows ONLY if all
  // retries are exhausted. Waits for delivery because the pod exits right after.
  static async retrying(attempt: number, max: number) {
    console.log(`📤 Events.retrying called: attempt ${attempt}/${max}`)
    return Events.EVENTS?.sendOnce("retrying", { attempt, max }, true)
  }

  // Final webhook events (replacing sendWebhookOnce)
  static async recordingSucceeded() {
    return Events.EVENTS?.sendOnce("recording_succeeded", {}, true)
  }

  static async recordingFailed(errorMessage: string) {
    console.log(`📤 Events.recordingFailed called with: ${errorMessage}`)
    return Events.EVENTS?.sendOnce("recording_failed", { error_message: errorMessage }, true)
  }

  private constructor(
    private botUuid: string,
    private botId: number,
    private extra: Record<string, unknown> | null
  ) {}

  /**
   * Send an event only once - prevents duplicate webhooks
   * Used for all events to ensure each event is sent exactly once
   */
  private async sendOnce(
    code: string,
    additionalData: Record<string, unknown> = {},
    waitForCompletion = false
  ): Promise<void> {
    if (this.sentEvents.has(code)) {
      console.log(`Event ${code} already sent, skipping...`)
      return
    }

    this.sentEvents.add(code)
    if (waitForCompletion) {
      // Send webhook and wait for completion
      await this.send(code, additionalData)
    } else {
      // Send webhook in parallel - don't wait for completion
      this.send(code, additionalData)
    }
  }

  private async send(code: string, additionalData: Record<string, unknown> = {}): Promise<void> {
    if (envVars.SERVERLESS) {
      console.log(`Serverless mode, skipping event delivery for ${code}`)
      return
    }
    try {
      await axios({
        method: "POST",
        url: "/bot-process/update-status",
        data: {
          bot_id: this.botId,
          bot_uuid: this.botUuid,
          event_code: code,
          event_data: additionalData,
          extra: this.extra
        }
      })
      console.log("Event sent successfully:", code, this.botId)
    } catch (error) {
      if (error instanceof Error) {
        console.warn(
          "Unable to send event (continuing execution):",
          code,
          this.botId,
          error.message
        )
      }
    }
  }
}
