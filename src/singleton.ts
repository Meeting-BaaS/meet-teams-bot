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
    private lastSilenceStart: number | null = null // Timestamp when silence started (ms)
    private soundDetectedInMeeting: boolean = false // True if sound was detected during meeting
    private recordingStartTime: number = 0 // Timestamp when FFmpeg recording started (ms)
    private shouldRetry: boolean = false // Retry flag
    private recordingFinalized: boolean = false // True once the recording is merged and entering upload
    private recoveryClaimed: boolean = false // True once a termination/crash path owns log-upload + requeue

    // Cumulative list of participant names seen during the meeting.
    // Used by alone-in-meeting detection as a proof-of-life gate:
    // the check only activates after at least one real participant
    // has been detected by the speaker observer.
    // Note: v1 filters the bot from the speaker list, so every entry
    // here is a real human participant.
    private participantNames: string[] = []

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

    public setStartTime(startTime: number): void {
        if (this.meetingParams === null) {
            throw new Error('Meeting params are not set')
        }
        this.meetingParams.start_time = startTime
    }

    public setExitTime(exitTime: number): void {
        if (this.meetingParams === null) {
            throw new Error('Meeting params are not set')
        }
        this.meetingParams.exit_time = exitTime
    }

    public setError(reason: MeetingEndReason, message?: string): void {
        // Don't override these end reasons — they represent a definitive decision
        // about why the bot is stopping and shouldn't be clobbered during cleanup
        if (
            this.endReason === MeetingEndReason.ApiRequest ||
            this.endReason === MeetingEndReason.LoginRequired ||
            this.endReason === MeetingEndReason.ExitingMeetingBeforeRecord
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

    public setLastSilenceStart(timestamp: number | null): void {
        // Only set if not already set (don't overwrite existing silence start)
        if (this.lastSilenceStart === null) {
            this.lastSilenceStart = timestamp
        } else if (timestamp === null) {
            // Reset silence start when sound is detected
            this.lastSilenceStart = null
        }
    }

    public getLastSilenceStart(): number | null {
        return this.lastSilenceStart
    }

    public setSoundDetectedInMeeting(detected: boolean): void {
        this.soundDetectedInMeeting = detected
    }

    public getSoundDetectedInMeeting(): boolean {
        return this.soundDetectedInMeeting
    }

    public setRecordingStartTime(timestamp: number): void {
        this.recordingStartTime = timestamp
    }

    public getRecordingStartTime(): number {
        return this.recordingStartTime
    }

    // Retry flag methods
    public setShouldRetry(value: boolean): void {
        this.shouldRetry = value
        if (value) {
            console.log('🔄 Marking error as retryable')
        }
    }

    // Phase marker: true once the recording has been MERGED into its final
    // output and is entering the upload phase. Crash/eviction handlers use it
    // to decide requeue vs preserve:
    //   - BEFORE finalize (join, or mid-recording): the only copy lives in
    //     ephemeral /tmp, which dies with the pod - REQUEUE to re-record.
    //   - AFTER finalize (uploading): the merged output exists and the
    //     S3Uploader EFS-fallback + reconciliation salvage any upload failure
    //     - do NOT requeue (that would re-record and duplicate).
    /**
     * Take ownership of recovery (log-upload + requeue). The first caller wins
     * and receives true; every subsequent caller receives false. Claimed ONLY
     * at the moment of a requeue, never up front — an up-front claim that then
     * takes a non-requeuing branch starves the other paths. Node's
     * single-threaded run-to-completion model makes the check-and-set atomic.
     */
    public claimRecovery(): boolean {
        if (this.recoveryClaimed) {
            return false
        }
        this.recoveryClaimed = true
        return true
    }

    public isRecoveryClaimed(): boolean {
        return this.recoveryClaimed
    }

    /**
     * Release a claim taken by claimRecovery() when the requeueToSQS() it
     * guarded FAILED to send — otherwise the stuck claim makes every other
     * requeue path stand down and the meeting is silently lost.
     */
    public releaseRecovery(): void {
        this.recoveryClaimed = false
    }

    public markRecordingFinalized(): void {
        this.recordingFinalized = true
    }

    public hasRecordingFinalized(): boolean {
        return this.recordingFinalized
    }

    public getShouldRetry(): boolean {
        return this.shouldRetry
    }

    public getRetryCount(): number {
        if (this.meetingParams === null) {
            return 0
        }
        return this.meetingParams.retry_count ?? 0
    }

    public addParticipantIfNotExists(name: string): void {
        if (!this.participantNames.includes(name)) {
            this.participantNames.push(name)
        }
    }

    public getParticipantNames(): string[] {
        return this.participantNames
    }
}

export let GLOBAL = new Global()
