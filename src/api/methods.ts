import axios from "axios"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"
import { getErrorMessageFromCode, type MeetingEndReason } from "../state-machine/types"

export class Api {
  public static instance: Api | null = null // Singleton class

  constructor() {
    if (Api.instance instanceof Api) {
      console.error("Class is singleton, constructor cannot be called multiple times.")
      return
    }
    axios.defaults.baseURL = envVars.API_SERVER_BASEURL
    axios.defaults.timeout = 30000 // 30 seconds
    Api.instance = this
  }

  // Finalize bot structure into BDD and send webhook
  public async endMeetingTrampoline() {
    const startTime = GLOBAL.get().startTime || Math.floor(Date.now() / 1000)
    const exitTime = GLOBAL.get().exitTime || Math.floor(Date.now() / 1000)

    const resp = await axios({
      method: "POST",
      url: "/bot-process/end-meeting-trampoline",
      params: {
        botId: GLOBAL.get().botId
      },
      data: {
        diarization_v2: false,
        bot_joined_at: startTime,
        bot_exited_at: exitTime
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

    try {
      await axios({
        method: "POST",
        url: "/bot-process/start-record-failed",
        timeout: 10000,
        data: {
          meeting_url: GLOBAL.get().meetingUrl,
          message: msg,
          ...(code && { error_code: code })
        },
        params: { botId: GLOBAL.get().botId }
      })
      console.log("Successfully notified backend of recording failure")
    } catch (error) {
      console.warn(
        "Unable to notify recording failure (continuing execution):",
        error instanceof Error ? error.message : error
      )
    }
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
