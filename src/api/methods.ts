import axios from 'axios'
import * as rax from 'retry-axios'

import {
    getErrorMessageFromCode,
    MeetingEndReason,
} from '../state-machine/types'
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
        axios.defaults.baseURL = GLOBAL.get().remote.api_server_baseurl
        axios.defaults.withCredentials = true
        if (!GLOBAL.isServerless() && GLOBAL.get().user_token) {
            // axios v1.x: use headers directly instead of deprecated headers.common
            axios.defaults.headers['Authorization'] = GLOBAL.get().user_token
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
    public async endMeetingTrampoline() {
        const startTime =
            GLOBAL.get().start_time || Math.floor(Date.now() / 1000)
        const exitTime = GLOBAL.get().exit_time || Math.floor(Date.now() / 1000)

        const resp = await axios({
            method: 'POST',
            url: '/bots/end_meeting_trampoline',
            // retry-axios would stack its 3 transport retries under
            // handleEndMeetingWithRetry's own 3 attempts — up to 12 sends of
            // this non-idempotent POST. The manual loop owns retrying.
            raxConfig: { retry: 0, noResponseRetries: 0 },
            params: {
                bot_uuid: GLOBAL.get().bot_uuid,
            },
            data: {
                diarization_v2: false,
                bot_joined_at: startTime,
                bot_exited_at: exitTime,
            },
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
            GLOBAL.getErrorMessage?.() ||
            (code
                ? getErrorMessageFromCode(code as MeetingEndReason)
                : 'Unknown error')

        try {
            await axios({
                method: 'POST',
                url: `/bots/start_record_failed`,
                timeout: 10000,
                data: {
                    meeting_url: GLOBAL.get().meeting_url,
                    message: msg,
                    ...(code && { error_code: code }),
                },
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

    /// Lightweight check to see if a stop request has been issued for this bot.
    /// Called on startup before joining the meeting.
    /// Returns true if the bot should stop, false otherwise.
    /// Failures are non-fatal — if the server is unreachable, returns false to let the bot proceed.
    public async checkStopRequest(): Promise<boolean> {
        try {
            const resp = await axios({
                method: 'GET',
                url: '/bots/check_stop_request',
                timeout: 10000,
                params: { bot_uuid: GLOBAL.get().bot_uuid },
            })
            const isStopped = resp.data?.is_stopped === true
            if (isStopped) {
                console.log(
                    `Bot ${GLOBAL.get().bot_uuid} has a pending stop request — will not join meeting`,
                )
            }
            return isStopped
        } catch (error) {
            console.warn(
                'check-stop-request failed (proceeding with join):',
                error instanceof Error ? error.message : error,
            )
            return false
        }
    }

    // Handle end meeting with retry logic
    public async handleEndMeetingWithRetry(): Promise<void> {
        if (GLOBAL.isServerless()) {
            console.log('Skipping endMeetingTrampoline - serverless mode')
            return
        }

        // The trampoline is NOT idempotent server-side (it kicks off
        // transcription submission), so exactly one path may report it: the
        // happy path or the crash handler's finalized branch.
        if (!GLOBAL.claimEndMeetingReport()) {
            // A loser of the claim must NOT return immediately — the crash
            // handler would then exit(1) and kill the owner's in-flight POST —
            // so it awaits the owner's promise instead.
            console.log(
                'endMeetingTrampoline already owned by another path — awaiting it',
            )
            if (this.endMeetingReportPromise) {
                const ownerSucceeded = await this.endMeetingReportPromise
                if (!ownerSucceeded) {
                    // The owner exhausted its attempts and released the claim.
                    // This path was already waiting to recover the report, so
                    // let it claim a fresh bounded attempt set instead of
                    // returning and exiting the process.
                    await this.handleEndMeetingWithRetry()
                }
            }
            return
        }

        // No await between the claim above and this assignment, so a losing
        // path always observes the promise (Node run-to-completion).
        this.endMeetingReportPromise = this.runEndMeetingAttempts()
        await this.endMeetingReportPromise
    }

    /**
     * In-flight end-meeting report owned by the path that won
     * GLOBAL.claimEndMeetingReport(); losers await it (see above).
     */
    private endMeetingReportPromise: Promise<boolean> | null = null

    private async runEndMeetingAttempts(): Promise<boolean> {
        // A failed trampoline orphans the bot at recording_succeeded (the
        // api-server never learns artifacts/duration and never starts
        // transcription), so retry transient failures before giving up.
        const delaysMs = [0, 2000, 6000]
        for (let attempt = 1; attempt <= delaysMs.length; attempt++) {
            try {
                if (delaysMs[attempt - 1] > 0) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, delaysMs[attempt - 1]),
                    )
                }
                await this.endMeetingTrampoline()
                console.log(
                    `API call to endMeetingTrampoline succeeded (attempt ${attempt})`,
                )
                return true
            } catch (error) {
                console.warn(
                    `API call to endMeetingTrampoline failed (attempt ${attempt}/${delaysMs.length}):`,
                    error instanceof Error ? error.message : error,
                )
            }
        }
        // All attempts failed — clear the in-flight handle and release the
        // claim so a later path (e.g. the crash handler) can still try.
        this.endMeetingReportPromise = null
        GLOBAL.releaseEndMeetingReport()
        console.warn(
            'endMeetingTrampoline exhausted all attempts (continuing execution)',
        )
        return false
    }
}
