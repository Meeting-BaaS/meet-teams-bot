import { NORMAL_END_REASONS } from './state-machine/constants'
import {
    getErrorMessageFromCode,
    MeetingEndReason,
} from './state-machine/types'
import { MeetingParams, RecordingMode } from './types'

class Global {
    private meetingParams: MeetingParams | null = null
    private endReason: MeetingEndReason | null = null
    private errorMessage: string | null = null
    public constructor() {}

    /**
     * Normalizes recording mode values to snake_case format.
     *
     * This function handles both PascalCase and snake_case values because:
     * 1. API requests come in snake_case format (e.g., "speaker_view")
     * 2. The API server converts these to PascalCase (e.g., "SpeakerView") when sending to the queue
     * 3. The smart-rabbit consumer can handle both cases via #[serde(alias = "...")] attributes
     * 4. The recording server needs to handle both cases for consistency with the queue message format
     *
     * @param mode - The recording mode value (can be either PascalCase or snake_case)
     * @returns The normalized recording mode in snake_case format
     */
    private normalizeRecordingMode(
        mode: RecordingMode,
    ): 'speaker_view' | 'gallery_view' | 'audio_only' {
        switch (mode) {
            case 'speaker_view':
            case 'SpeakerView':
                return 'speaker_view'
            case 'gallery_view':
            case 'GalleryView':
                return 'speaker_view' // gallery_view maps to speaker_view as requested
            case 'audio_only':
            case 'AudioOnly':
                return 'audio_only'
            default:
                // Default to speaker_view if unknown
                console.warn(
                    `Unknown recording mode: ${mode}, defaulting to speaker_view`,
                )
                return 'speaker_view'
        }
    }

    public set(meetingParams: MeetingParams) {
        if (this.meetingParams !== null) {
            throw new Error('Meeting params are already set')
        }

        // Validate critical parameters before setting them
        if (
            !meetingParams.meeting_url ||
            meetingParams.meeting_url.trim() === ''
        ) {
            throw new Error('Missing required parameter: meeting_url')
        }
        if (!meetingParams.bot_uuid || meetingParams.bot_uuid.trim() === '') {
            throw new Error('Missing required parameter: bot_uuid')
        }

        // Normalize the recording mode before setting
        const normalizedParams = {
            ...meetingParams,
            recording_mode: this.normalizeRecordingMode(
                meetingParams.recording_mode,
            ),
        }

        this.meetingParams = normalizedParams
        console.log(
            `🤖 Bot ${meetingParams.bot_uuid} initialized with validated parameters`,
        )
    }

    public get(): MeetingParams {
        if (this.meetingParams === null) {
            throw new Error('Meeting params are not set')
        }
        return this.meetingParams
    }

    public isServerless(): boolean {
        if (this.meetingParams === null) {
            throw new Error('Meeting params are not set')
        }
        return this.meetingParams.remote === null
    }

    public setError(reason: MeetingEndReason, message?: string): void {
        // ApiRequest is a special case where we don't want to override an existing error
        if (
            this.endReason === MeetingEndReason.ApiRequest ||
            this.endReason === MeetingEndReason.LoginRequired
        ) {
            console.log(
                `🔴 not setting global error, already set to: ${this.endReason}`,
            )
            return
        }

        // If we already have a custom error message for the same reason, and no new message is provided, preserve the existing custom message
        if (
            this.endReason === reason &&
            !message &&
            this.errorMessage &&
            this.errorMessage !== getErrorMessageFromCode(reason)
        ) {
            console.log(
                `🔴 Preserving existing custom error message for ${reason}: "${this.errorMessage}"`,
            )
            return
        }

        console.log(`🔴 Setting global error: ${reason}`)
        this.endReason = reason
        this.errorMessage = message || getErrorMessageFromCode(reason)
        console.log(`🔴 End reason set to: ${this.endReason}`)
    }

    public setEndReason(reason: MeetingEndReason): void {
        console.log(`🔵 Setting global end reason: ${reason}`)
        this.endReason = reason

        if (NORMAL_END_REASONS.includes(reason)) {
            console.log(
                `🔵 Clearing error state for normal termination: ${reason}`,
            )
            // This ensures that an error message isn't propagated to the client for normal termination
            this.clearError()
        }
    }

    public getEndReason(): MeetingEndReason | null {
        return this.endReason
    }

    public getErrorMessage(): string | null {
        return this.errorMessage
    }

    public hasError(): boolean {
        // Only return true if we have an error message (indicating an actual error)
        // Having an end reason alone doesn't mean there's an error
        return this.errorMessage !== null
    }

    public clearError(): void {
        // Only clear the error message, keep the end reason
        // This allows normal termination reasons to be preserved
        this.errorMessage = null
    }
}

export let GLOBAL = new Global()
