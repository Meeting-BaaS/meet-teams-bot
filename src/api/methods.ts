import axios from 'axios'
import * as rax from 'retry-axios'

import { ScreenRecorderManager } from '../recording/ScreenRecorder'
import {
    getErrorMessageFromCode,
    MeetingEndReason,
} from '../state-machine/types'
import { BotFailedRequest, BotSuccessRequest } from '../types'
import { ApiTypes } from './types'

import { GLOBAL } from '../singleton'

export class Api {
    public static instance: Api | null = null // Singleton class

    constructor() {
        if (Api.instance instanceof Api) {
            console.error(
                'Class is singleton, constructor cannot be called multiple times.',
            )
            return Api.instance
        }
        axios.defaults.baseURL = GLOBAL.get().core_server_url
        axios.defaults.withCredentials = true
        // Set Authorization header with secret for V2 API
        if (!GLOBAL.isServerless()) {
            axios.defaults.headers.common['Authorization'] = GLOBAL.get().secret
        }
        axios.defaults.raxConfig = {
            instance: axios,
            retry: 2, // Number of retry attempts
            backoffType: 'exponential',
            noResponseRetries: 2, // Number of retries for no responses
            retryDelay: 1000, // Delay between each retry in milliseconds
            httpMethodsToRetry: [
                'GET',
                'HEAD',
                'OPTIONS',
                'DELETE',
                'PUT',
                'POST',
            ],
            statusCodesToRetry: [
                [100, 199],
                [400, 499],
                [500, 599],
            ],
            onRetryAttempt: this.onRetryAttempt,
        }
        rax.attach()
        Api.instance = this
    }

    private onRetryAttempt(err: any) {
        const cfg = rax.getConfig(err)
        const response =
            err.response && err.response.data ? err.response.data : err
        const request = err.request

        console.log(
            'Attempt of a new trial #',
            cfg && cfg.currentRetryAttempt,
            {
                url: request.url,
                method: request.method,
                params: request.params,
                headers: request.headers,
                data: request.data,
                response: response,
            },
        )
    }

    // Finalize bot structure into BDD and send webhook
    public async endMeetingTrampoline(mediaDurationSec: number = 0) {
        const successRequest: BotSuccessRequest = {
            webhook_url: GLOBAL.get().bots_webhook_url,
            speech_to_text: GLOBAL.get().speech_to_text_api_parameters,
            transcription_custom_parameters:
                GLOBAL.get().transcription_custom_parameters,
            diarization_v2: false,
            transcription_fail_count: undefined,
            diarization_fail_count: undefined,
            media_duration_sec: mediaDurationSec,
        }

        const resp = await axios({
            method: 'POST',
            url: '/bots/end_meeting_trampoline',
            params: {
                bot_uuid: GLOBAL.get().bot_uuid,
            },
            data: successRequest,
        })
        return resp.data
    }

    // Post transcript to server
    public async postTranscript(
        transcript: ApiTypes.PostableTranscript,
    ): Promise<ApiTypes.QueryableTranscript> {
        return (
            await axios({
                method: 'POST',
                url: `/bots/transcripts/${GLOBAL.get().bot_uuid}/diarization`,
                data: transcript,
            })
        ).data
    }

    // Patch existing transcript
    public async patchTranscript(
        transcript: ApiTypes.ChangeableTranscript,
    ): Promise<ApiTypes.QueryableTranscript> {
        return (
            await axios({
                method: 'PATCH',
                url: `/bots/transcripts/${GLOBAL.get().bot_uuid}/diarization`,
                data: transcript,
            })
        ).data
    }

    public async notifyRecordingFailure(
        message?: string,
        errorCode?: string,
    ): Promise<void> {
        const code = errorCode || GLOBAL.getEndReason?.()
        const msg =
            message ||
            (code
                ? getErrorMessageFromCode(code as MeetingEndReason)
                : 'Unknown error')

        if (!code) {
            console.warn('No error code available for failure notification')
            return
        }

        const failureRequest: BotFailedRequest = {
            webhook_url: GLOBAL.get().bots_webhook_url,
            message: msg,
            error_code: code,
        }

        try {
            await axios({
                method: 'POST',
                url: `/bots/start_record_failed`,
                timeout: 10000,
                data: failureRequest,
                params: { bot_uuid: GLOBAL.get().bot_uuid },
            })
            console.log('Successfully notified backend of recording failure')
        } catch (error) {
            console.warn(
                'Unable to notify recording failure (continuing execution):',
                error instanceof Error ? error.message : error,
            )
        }
    }

    // Handle end meeting with retry logic
    public async handleEndMeetingWithRetry(): Promise<void> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping endMeetingTrampoline - serverless mode')
            return
        }

        try {
            // Get media duration from ScreenRecorder if available
            const mediaDurationSec =
                ScreenRecorderManager.getInstance().getMediaDurationSec()
            await this.endMeetingTrampoline(mediaDurationSec)
            console.log('API call to endMeetingTrampoline succeeded')
        } catch (error) {
            console.warn(
                'API call to endMeetingTrampoline failed (continuing execution):',
                error instanceof Error ? error.message : error,
            )
            // Don't throw - continue execution even if API call fails
        }
    }
}
