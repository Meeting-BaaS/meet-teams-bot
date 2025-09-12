import { Events } from '../../events'
import { Streaming } from '../../streaming'
import { MEETING_CONSTANTS } from '../constants'

import {
    MeetingEndReason,
    MeetingStateType,
    StateExecuteResult,
} from '../types'
import { BaseState } from './base-state'

import {
    AudioWarningEvent,
    ScreenRecorderManager,
} from '../../recording/ScreenRecorder'
import { GLOBAL } from '../../singleton'
import { sleep } from '../../utils/sleep'

// Sound level threshold for considering activity (0-100)
const SOUND_LEVEL_ACTIVITY_THRESHOLD = 5

export class RecordingState extends BaseState {
    private isProcessing: boolean = true
    private readonly CHECK_INTERVAL = 250
    private noAttendeesConfirmationStartTime: number = 0

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

        // Get recorder instance once to avoid repeated getInstance() calls
        const recorder = ScreenRecorderManager.getInstance()

        // Configure event listeners for screen recorder
        recorder.on('error', async (error) => {
            console.error('ScreenRecorder error:', error)

            // Handle different error shapes safely
            let errorMessage: string
            if (error instanceof Error) {
                // Direct Error instance
                errorMessage = error.message
            } else if (
                error &&
                typeof error === 'object' &&
                'type' in error &&
                error.type === 'startError' &&
                'error' in error
            ) {
                // Object with type 'startError' and nested error
                const nestedError = (error as any).error
                errorMessage =
                    nestedError instanceof Error
                        ? nestedError.message
                        : String(nestedError)
            } else {
                // Fallback for unknown error shapes
                errorMessage =
                    error && typeof error === 'object' && 'message' in error
                        ? String(error.message)
                        : String(error)
            }

            GLOBAL.setError(MeetingEndReason.StreamingSetupFailed, errorMessage)
            this.isProcessing = false
        })

        // Handle audio warnings (non-critical audio issues) - just log them
        recorder.on('audioWarning', (warningInfo: AudioWarningEvent) => {
            console.warn('ScreenRecorder audio warning:', warningInfo)
            console.log(`⚠️ Audio quality warning: ${warningInfo.message}`)
            // Non-fatal: keep recording
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

            // Check for sound activity first - if detected, reset all silence timers
            if (Streaming.instance) {
                const currentSoundLevel =
                    Streaming.instance.getCurrentSoundLevel()
                if (currentSoundLevel > SOUND_LEVEL_ACTIVITY_THRESHOLD) {
                    console.log(
                        `[checkEndConditions] Sound activity detected (${currentSoundLevel.toFixed(2)}), resetting all silence timers`,
                    )
                    // Reset both silence timers when sound is detected
                    this.noAttendeesConfirmationStartTime = 0
                    this.context.noSpeakerDetectedTime = 0
                    return { shouldEnd: false }
                }
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

        // If participants are present, reset timer and exit
        if (attendeesCount > 0) {
            this.noAttendeesConfirmationStartTime = 0
            return false
        }

        // Check if we should consider ending due to no attendees
        const noAttendeesTimeout =
            startTime + MEETING_CONSTANTS.INITIAL_WAIT_TIME < now
        const shouldConsiderEnding = noAttendeesTimeout || firstUserJoined

        // If we shouldn't consider ending, reset timer and exit
        if (!shouldConsiderEnding) {
            this.noAttendeesConfirmationStartTime = 0
            return false
        }

        // Start confirmation timer if not already started
        if (this.noAttendeesConfirmationStartTime === 0) {
            this.noAttendeesConfirmationStartTime = now
            console.log(
                '[checkNoAttendees] Starting empty meeting confirmation timer',
            )
            return false
        }

        // Check if we've had no attendees for long enough
        const noAttendeesDuration = now - this.noAttendeesConfirmationStartTime
        const hasEnoughConfirmation: boolean =
            noAttendeesDuration >=
            MEETING_CONSTANTS.EMPTY_MEETING_CONFIRMATION_MS

        // Log progress if we're still waiting
        if (
            !hasEnoughConfirmation &&
            noAttendeesDuration % 5000 < this.CHECK_INTERVAL
        ) {
            console.log(
                `[checkNoAttendees] Waiting for empty meeting confirmation: ${Math.floor(noAttendeesDuration / 1000)}s / ${MEETING_CONSTANTS.EMPTY_MEETING_CONFIRMATION_MS / 1000}s`,
            )
        }

        if (hasEnoughConfirmation) {
            console.log(
                `[checkNoAttendees] Empty meeting confirmation reached (${Math.floor(noAttendeesDuration / 1000)}s), checking for sound activity`,
            )
            // Check if there's sound activity before ending due to no attendees
            return this.checkNoSpeaker(now)
        }

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

        // Check if the silence period has exceeded the timeout
        const silenceDurationSeconds = Math.floor(
            (now - noSpeakerDetectedTime) / 1000,
        )
        const shouldEnd =
            noSpeakerDetectedTime + MEETING_CONSTANTS.SILENCE_TIMEOUT < now

        if (shouldEnd) {
            console.log(
                `[checkNoSpeaker] No sound activity detected for ${silenceDurationSeconds} seconds, ending meeting`,
            )
        } else {
            // Log progress periodically
            if (silenceDurationSeconds % 30 === 0) {
                // Log every 30 seconds
                console.log(
                    `[checkNoSpeaker] No speaker detected for ${silenceDurationSeconds}s / ${MEETING_CONSTANTS.SILENCE_TIMEOUT / 1000}s`,
                )
            }
        }

        return shouldEnd
    }
}
