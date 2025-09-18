import axios from 'axios'
import { GLOBAL } from './singleton'

export class Events {
    private static EVENTS: Events | null = null
    private sentEvents: Set<string> = new Set()

    static init() {
        if (GLOBAL.get().bot_uuid == null) return
        if (GLOBAL.get().bots_api_key == null) return
        if (GLOBAL.get().bots_webhook_url == null) return

        Events.EVENTS = new Events(
            GLOBAL.get().bot_uuid,
            GLOBAL.get().bots_api_key,
            GLOBAL.get().bots_webhook_url,
        )
    }

    static async apiRequestStop() {
        return Events.EVENTS?.sendOnce('api_request_stop')
    }

    static async joiningCall() {
        return Events.EVENTS?.sendOnce('joining_call')
    }

    static async inWaitingRoom() {
        return Events.EVENTS?.sendOnce('in_waiting_room')
    }

    static async inCallNotRecording() {
        return Events.EVENTS?.sendOnce('in_call_not_recording')
    }

    static async inCallRecording(data: { start_time: number }) {
        return Events.EVENTS?.sendOnce('in_call_recording', data)
    }

    static async recordingPaused() {
        // Send webhook in parallel - don't wait for completion
        Events.EVENTS?.send('recording_paused')
    }

    static async recordingResumed() {
        // Send webhook in parallel - don't wait for completion
        Events.EVENTS?.send('recording_resumed')
    }

    static async callEnded() {
        return Events.EVENTS?.sendOnce('call_ended')
    }

    // Nouveaux événements pour les erreurs
    static async botRejected() {
        return Events.EVENTS?.sendOnce('bot_rejected')
    }

    static async botRemoved() {
        return Events.EVENTS?.sendOnce('bot_removed')
    }

    static async botRemovedTooEarly() {
        return Events.EVENTS?.sendOnce('bot_removed_too_early')
    }

    static async waitingRoomTimeout() {
        return Events.EVENTS?.sendOnce('waiting_room_timeout')
    }

    static async invalidMeetingUrl() {
        return Events.EVENTS?.sendOnce('invalid_meeting_url')
    }

    static async meetingError(error: Error) {
        return Events.EVENTS?.sendOnce('meeting_error', {
            error_message: error.message,
            error_type: error.constructor.name,
        })
    }

    // Final webhook events (replacing sendWebhookOnce)
    static async recordingSucceeded() {
        return Events.EVENTS?.sendOnce('recording_succeeded')
    }

    static async recordingFailed(errorMessage: string) {
        console.log(`📤 Events.recordingFailed called with: ${errorMessage}`)
        return Events.EVENTS?.sendOnce('recording_failed', {
            error_message: errorMessage,
        })
    }

    private constructor(
        private botId: string,
        private apiKey: string,
        private webhookUrl: string,
    ) {}

    /**
     * Send an event only once - prevents duplicate webhooks
     * Used for all events to ensure each event is sent exactly once
     */
    private async sendOnce(
        code: string,
        additionalData: Record<string, any> = {},
    ): Promise<void> {
        if (this.sentEvents.has(code)) {
            console.log(`Event ${code} already sent, skipping...`)
            return
        }

        this.sentEvents.add(code)
        // Send webhook in parallel - don't wait for completion
        this.send(code, additionalData)
    }

    private async send(
        code: string,
        additionalData: Record<string, any> = {},
    ): Promise<void> {
        try {
            await axios({
                method: 'POST',
                url: this.webhookUrl,
                timeout: 5000,
                headers: {
                    'User-Agent': 'meetingbaas/1.0',
                    'x-meeting-baas-api-key': this.apiKey,
                },
                data: {
                    event: 'bot.status_change',
                    data: {
                        bot_id: this.botId,
                        status: {
                            code,
                            created_at: new Date().toISOString(),
                            ...additionalData,
                        },
                    },
                },
            })
            console.log(
                'Event sent successfully:',
                code,
                this.botId
            )
        } catch (error) {
            if (error instanceof Error) {
                console.warn(
                    'Unable to send event (continuing execution):',
                    code,
                    this.botId,
                    error.message,
                )
            }
        }
    }
}
