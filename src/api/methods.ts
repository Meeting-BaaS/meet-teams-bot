import axios, { type AxiosError, type AxiosRequestConfig } from "axios"
import * as rax from "retry-axios"
import { envVars } from "../config/env-vars"
import { GLOBAL } from "../singleton"
import { getErrorMessageFromCode, type MeetingEndReason } from "../state-machine/types"
import type { ApiTypes } from "./types"

export class Api {
  public static instance: Api | null = null // Singleton class

  constructor() {
    if (Api.instance instanceof Api) {
      console.error("Class is singleton, constructor cannot be called multiple times.")
      return
    }
    axios.defaults.baseURL = envVars.API_SERVER_BASEURL
    axios.defaults.withCredentials = true
    axios.defaults.headers.common["x-api-key"] = envVars.API_SECRET
    axios.defaults.raxConfig = {
      instance: axios,
      retry: 2, // Number of retry attempts
      backoffType: "exponential",
      noResponseRetries: 2, // Number of retries for no responses
      retryDelay: 1000, // Delay between each retry in milliseconds
      httpMethodsToRetry: ["GET", "HEAD", "OPTIONS", "DELETE", "PUT", "POST"],
      statusCodesToRetry: [
        [100, 199],
        [400, 499],
        [500, 599]
      ],
      onRetryAttempt: this.onRetryAttempt
    }
    rax.attach()
    Api.instance = this
  }

  private onRetryAttempt(err: AxiosError) {
    const cfg = rax.getConfig(err)
    const response = err.response?.data ?? err
    const request = err.request as AxiosRequestConfig

    console.log("Attempt of a new trial #", cfg?.currentRetryAttempt, {
      url: request.url,
      method: request.method,
      params: request.params,
      headers: request.headers,
      data: request.data,
      response: response
    })
  }

  // Finalize bot structure into BDD and send webhook
  public async endMeetingTrampoline() {
    const startTime = GLOBAL.get().start_time || Math.floor(Date.now() / 1000)
    const exitTime = GLOBAL.get().exit_time || Math.floor(Date.now() / 1000)

    const resp = await axios({
      method: "POST",
      url: "/bots/end_meeting_trampoline",
      params: {
        bot_uuid: GLOBAL.get().bot_uuid
      },
      data: {
        diarization_v2: false,
        bot_joined_at: startTime,
        bot_exited_at: exitTime
      }
    })
    return resp.data
  }

  // Post transcript to server
  public async postTranscript(
    transcript: ApiTypes.PostableTranscript
  ): Promise<ApiTypes.QueryableTranscript> {
    return (
      await axios({
        method: "POST",
        url: `/bots/transcripts/${GLOBAL.get().bot_uuid}/diarization`,
        data: transcript
      })
    ).data
  }

  // Patch existing transcript
  public async patchTranscript(
    transcript: ApiTypes.ChangeableTranscript
  ): Promise<ApiTypes.QueryableTranscript> {
    return (
      await axios({
        method: "PATCH",
        url: `/bots/transcripts/${GLOBAL.get().bot_uuid}/diarization`,
        data: transcript
      })
    ).data
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
        url: "/bots/start_record_failed",
        timeout: 10000,
        data: {
          meeting_url: GLOBAL.get().meeting_url,
          message: msg,
          ...(code && { error_code: code })
        },
        params: { bot_uuid: GLOBAL.get().bot_uuid }
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
