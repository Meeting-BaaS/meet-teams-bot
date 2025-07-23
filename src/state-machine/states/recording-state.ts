import { Events } from '../../events'
import { Streaming } from '../../streaming'
import { MEETING_CONSTANTS, OCR_CONSTANTS } from '../constants'

import {
    MeetingEndReason,
    MeetingStateType,
    StateExecuteResult,
} from '../types'
import { BaseState } from './base-state'

import { ScreenRecorderManager } from '../../recording/ScreenRecorder'
import { GLOBAL } from '../../singleton'
import { CAPTCHAHandler } from '../../utils/CAPTCHAHandler'
import { sleep } from '../../utils/sleep'

// Sound level threshold for considering activity (0-100)
const SOUND_LEVEL_ACTIVITY_THRESHOLD = 5

export class RecordingState extends BaseState {
    private isProcessing: boolean = true
    private readonly CHECK_INTERVAL = 250
    private noAttendeesWithSilenceStartTime: number = 0
    private readonly SILENCE_CONFIRMATION_MS = 45000 // 45 seconds of silence before confirming no attendees

    async execute(): StateExecuteResult {
        try {
            console.info('Starting recording state')

            // Initialize recording
            await this.initializeRecording()

            // Set a global timeout for the recording state
            const startTime = Date.now()
            this.context.startTime = startTime // Assign to context so getStartTime() works
            ScreenRecorderManager.getInstance().setMeetingStartTime(startTime)

            // Uncomment this to test the recording synchronization
            // await sleep(10000)
            // await generateSyncSignal(this.context.playwrightPage)

            // Main loop
            while (this.isProcessing) {
                // Check global timeout
                if (
                    Date.now() - startTime >
                    MEETING_CONSTANTS.RECORDING_TIMEOUT
                ) {
                    console.warn(
                        'Global recording state timeout reached, forcing end',
                    )
                    GLOBAL.setEndReason(MeetingEndReason.RecordingTimeout)
                    await this.handleMeetingEnd(
                        MeetingEndReason.RecordingTimeout,
                    )
                    break
                }

                // Check if we should stop
                const { shouldEnd, reason } = await this.checkEndConditions()

                if (shouldEnd) {
                    console.info(`Meeting end condition met: ${reason}`)
                    // Set the end reason in the global singleton
                    GLOBAL.setEndReason(reason)
                    await this.handleMeetingEnd(reason)
                    break
                }

                // If pause requested, transition to Paused state
                if (this.context.isPaused) {
                    return this.transition(MeetingStateType.Paused)
                }

                // Perform continuous OCR analysis if enabled
                if (OCR_CONSTANTS.ENABLE_CONTINUOUS_OCR) {
                    try {
                        const captchaHandler = new CAPTCHAHandler()
                        await captchaHandler.performContinuousOCR(
                            this.context.playwrightPage,
                            'recording',
                        )
                    } catch (ocrError) {
                        console.warn(
                            '⚠️ Continuous OCR error (non-blocking):',
                            ocrError,
                        )
                        // Don't let OCR errors stop the recording
                    }
                }

                await sleep(this.CHECK_INTERVAL)
            }

            // Stop the observer before transitioning to Cleanup state
            console.info(
                '🔄 Recording state loop ended, transitioning to cleanup state',
            )
            return this.transition(MeetingStateType.Cleanup)
        } catch (error) {
            console.error('❌ Error in recording state:', error)
            console.error('❌ Error stack:', (error as Error).stack)
            return this.handleError(error as Error)
        }
    }

    private async initializeRecording(): Promise<void> {
        console.info('Initializing recording...')

        // Log the context state
        console.info('Context state:', {
            hasPathManager: !!this.context.pathManager,
            hasStreamingService: !!this.context.streamingService,
            isStreamingInstanceAvailable: !!Streaming.instance,
        })

        // Configure listeners
        await this.setupEventListeners()
        console.info('Recording initialized successfully')
    }

    private async setupEventListeners(): Promise<void> {
        console.info('Setting up event listeners...')

        // Configure event listeners for screen recorder
        ScreenRecorderManager.getInstance().on('error', async (error) => {
            console.error('ScreenRecorder error:', error)
            GLOBAL.setError(
                MeetingEndReason.StreamingSetupFailed,
                error.message,
            )
            this.isProcessing = false
        })

        console.info('Event listeners setup complete')
    }

    private async checkEndConditions(): Promise<{
        shouldEnd: boolean
        reason?: MeetingEndReason
    }> {
        try {
            const now = Date.now()

            // Check if stop was requested via state machine
            if (GLOBAL.getEndReason()) {
                return { shouldEnd: true, reason: GLOBAL.getEndReason() }
            }

            // Check if bot was removed (with timeout protection)
            const botRemovedResult = await Promise.race([
                this.checkBotRemoved(),
                new Promise<boolean>((_, reject) =>
                    setTimeout(
                        () => reject(new Error('Bot removed check timeout')),
                        10000,
                    ),
                ),
            ])

            if (botRemovedResult) {
                return this.getBotRemovedReason()
            }

            // Check participants and audio activity
            if (await this.checkNoAttendees(now)) {
                return { shouldEnd: true, reason: MeetingEndReason.NoAttendees }
            }

            if (await this.checkNoSpeaker(now)) {
                return { shouldEnd: true, reason: MeetingEndReason.NoSpeaker }
            }

            return { shouldEnd: false }
        } catch (error) {
            console.error('Error checking end conditions:', error)
            return this.getBotRemovedReason()
        }
    }

    /**
     * Helper method to determine the correct reason when bot is removed
     * Uses existing error from ScreenRecorder if available, otherwise BotRemoved
     */
    private getBotRemovedReason(): {
        shouldEnd: true
        reason: MeetingEndReason
    } {
        // Check if we already have an error from ScreenRecorder or other sources
        if (GLOBAL.hasError()) {
            const existingReason = GLOBAL.getEndReason()
            // Defensive null check: handle null, undefined, or any falsy values
            if (existingReason === null || existingReason === undefined) {
                console.warn(
                    'GLOBAL.getEndReason() returned null/undefined despite hasError() being true, using default reason',
                )
                return { shouldEnd: true, reason: MeetingEndReason.BotRemoved }
            }
            console.log(
                `Using existing error instead of BotRemoved: ${existingReason}`,
            )
            return { shouldEnd: true, reason: existingReason }
        }

        return { shouldEnd: true, reason: MeetingEndReason.BotRemoved }
    }
    private async handleMeetingEnd(reason: MeetingEndReason): Promise<void> {
        console.info(`Handling meeting end with reason: ${reason}`)
        try {
            // Try to close the meeting but don't let an error here affect the rest
            try {
                // If the reason is bot_removed, we know the meeting is already effectively closed
                if (reason === MeetingEndReason.BotRemoved) {
                    console.info(
                        'Bot was removed from meeting, skipping active closure step',
                    )
                } else {
                    await this.context.provider.closeMeeting(
                        this.context.playwrightPage,
                    )
                }
            } catch (closeError) {
                console.error(
                    'Error closing meeting, but continuing process:',
                    closeError,
                )
            }

            // These critical steps must execute regardless of previous steps
            console.info('Triggering call ended event')
            await Events.callEnded()

            console.info('Setting isProcessing to false to end recording loop')
        } catch (error) {
            console.error('Error during meeting end handling:', error)
        } finally {
            // Always ensure this flag is set to stop the processing loop
            this.isProcessing = false
            console.info('Meeting end handling completed')
        }
    }

    private async checkBotRemoved(): Promise<boolean> {
        if (!this.context.playwrightPage) {
            console.error('Playwright page not available')
            return true
        }

        try {
            return await this.context.provider.findEndMeeting(
                this.context.playwrightPage,
            )
        } catch (error) {
            console.error('Error checking if bot was removed:', error)
            return false
        }
    }

    /**
     * Checks if the meeting should end due to lack of participants
     * @param now Current timestamp
     * @returns true if the meeting should end due to lack of participants
     */
    private checkNoAttendees(now: number): boolean {
        const attendeesCount = this.context.attendeesCount || 0
        const startTime = this.context.startTime || 0
        const firstUserJoined = this.context.firstUserJoined || false

        // If participants are present, no need to end and reset silence timer
        if (attendeesCount > 0) {
            this.noAttendeesWithSilenceStartTime = 0
            return false
        }

        // True if we've exceeded the initial 7 minutes without any participants
        const noAttendeesTimeout =
            startTime + MEETING_CONSTANTS.INITIAL_WAIT_TIME < now

        // True if at least one user joined and then left
        const noAttendeesAfterJoin = firstUserJoined

        // Check if we should consider ending due to no attendees
        const shouldConsiderEnding = noAttendeesTimeout || noAttendeesAfterJoin

        // If we should consider ending, check for silence confirmation
        if (shouldConsiderEnding) {
            // If this is the first time we're detecting no attendees, start the silence timer
            if (this.noAttendeesWithSilenceStartTime === 0) {
                this.noAttendeesWithSilenceStartTime = now
                return false
            }

            // Check if we've had silence for long enough
            const silenceDuration = now - this.noAttendeesWithSilenceStartTime
            const hasEnoughSilence =
                silenceDuration >= this.SILENCE_CONFIRMATION_MS

            // If we're tracking silence but haven't reached the threshold, log the progress
            if (
                !hasEnoughSilence &&
                silenceDuration % 5000 < this.CHECK_INTERVAL
            ) {
                console.log(
                    `[checkNoAttendees] Waiting for silence confirmation: ${Math.floor(silenceDuration / 1000)}s / ${this.SILENCE_CONFIRMATION_MS / 1000}s`,
                )
            }

            return hasEnoughSilence
        }

        // Reset silence timer if we're not considering ending
        this.noAttendeesWithSilenceStartTime = 0
        return false
    }

    /**
     * Checks if the meeting should end due to absence of sound
     * @param now Current timestamp
     * @returns true if the meeting should end due to absence of sound
     */
    private checkNoSpeaker(now: number): boolean {
        const noSpeakerDetectedTime = this.context.noSpeakerDetectedTime || 0

        // If no silence period has been detected, no need to end
        if (noSpeakerDetectedTime <= 0) {
            return false
        }

        // Check current sound level if streaming is available
        if (Streaming.instance) {
            const currentSoundLevel = Streaming.instance.getCurrentSoundLevel()

            // More detailed sound level logging
            // console.log(`[checkNoSpeaker] Current sound level: ${currentSoundLevel.toFixed(2)}, threshold: ${SOUND_LEVEL_ACTIVITY_THRESHOLD}`);

            // If sound is detected above threshold, reset the silence counter
            if (currentSoundLevel > SOUND_LEVEL_ACTIVITY_THRESHOLD) {
                console.log(
                    `[checkNoSpeaker] Sound activity detected (${currentSoundLevel.toFixed(2)}), resetting silence timer`,
                )
                this.context.noSpeakerDetectedTime = 0
                return false
            }
        } else {
            console.warn(
                '[checkNoSpeaker] Streaming instance not available, cannot check sound levels',
            )
        }

        // Check if the silence period has exceeded the timeout
        const silenceDuration = Math.floor((now - noSpeakerDetectedTime) / 1000)
        const shouldEnd =
            noSpeakerDetectedTime + MEETING_CONSTANTS.SILENCE_TIMEOUT < now

        if (shouldEnd) {
            console.log(
                `[checkNoSpeaker] No sound activity detected for ${silenceDuration} seconds, ending meeting`,
            )
        }

        return shouldEnd
    }
}
