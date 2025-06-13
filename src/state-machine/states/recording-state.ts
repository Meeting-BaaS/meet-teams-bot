import { Events } from '../../events'
import { Streaming } from '../../streaming'
import { MEETING_CONSTANTS } from '../constants'

import {
    MeetingStateType,
    RecordingEndReason,
    StateExecuteResult,
} from '../types'
import { BaseState } from './base-state'

import { RECORDING } from '../../main'
import { SCREEN_RECORDER } from '../../recording/ScreenRecorder'
import { PathManager } from '../../utils/PathManager'

// Sound level threshold for considering activity (0-100)
const SOUND_LEVEL_ACTIVITY_THRESHOLD = 5

export class RecordingState extends BaseState {
    private isProcessing: boolean = true
    private pathManager: PathManager
    private readonly CHECK_INTERVAL = 250
    private noAttendeesWithSilenceStartTime: number = 0
    private readonly SILENCE_CONFIRMATION_MS = 45000 // 45 seconds of silence before confirming no attendees

    async execute(): StateExecuteResult {
        try {
            console.info('Starting recording state')

            // Start the dialog observer when entering this state
            this.startDialogObserver()

            // Initialize PathManager
            this.pathManager = PathManager.getInstance(
                this.context.params.bot_uuid,
            )
            await this.pathManager.initializePaths()

            // Initialize recording
            await this.initializeRecording()

            // Set a global timeout for the recording state
            const startTime = Date.now()

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
                    await this.handleMeetingEnd(
                        RecordingEndReason.RecordingTimeout,
                    )
                    break
                }

                // Check if we should stop
                const { shouldEnd, reason } = await this.checkEndConditions()

                if (shouldEnd) {
                    console.info(`Meeting end condition met: ${reason}`)
                    await this.handleMeetingEnd(reason)
                    break
                }

                // If pause requested, transition to Paused state
                if (this.context.isPaused) {
                    return this.transition(MeetingStateType.Paused)
                }

                await this.sleep(this.CHECK_INTERVAL)
            }

            // Stop the observer before transitioning to Cleanup state
            this.stopDialogObserver()
            return this.transition(MeetingStateType.Cleanup)
        } catch (error) {
            // Stop the observer in case of error
            this.stopDialogObserver()

            console.error('Error in recording state:', error)
            return this.handleError(error as Error)
        }
    }

    private async initializeRecording(): Promise<void> {
        console.info('Initializing recording...')

        // Start streaming seulement si RECORDING est activé
        if (RECORDING && this.context.streamingService) {
            console.info('Starting streaming service from recording state')
            this.context.streamingService.start()

            // Check that the instance is properly created
            if (!Streaming.instance) {
                console.warn(
                    'Streaming service not properly initialized, trying fallback initialization',
                )
                // If the instance is not available after starting, we might have a problem
                Streaming.instance = this.context.streamingService
            }
        } else if (!RECORDING) {
            console.info('RECORDING disabled - skipping streaming service initialization')
        } else {
            console.warn('No streaming service available in context')
        }

        // Log the context state
        console.info('Context state:', {
            hasPathManager: !!this.context.pathManager,
            hasStreamingService: !!this.context.streamingService,
            isStreamingInstanceAvailable: !!Streaming.instance,
            isScreenRecorderConfigured: RECORDING ? SCREEN_RECORDER.getStatus().isConfigured : 'N/A (RECORDING disabled)',
        })

        // Configure listeners
        await this.setupEventListeners()
        console.info('Recording initialized successfully')
    }

    private async setupEventListeners(): Promise<void> {
        console.info('Setting up event listeners...')

        // Seulement configurer les event listeners du screen recorder si RECORDING est activé
        if (RECORDING) {
            SCREEN_RECORDER.on('error', async (error) => {
                console.error('ScreenRecorder error:', error)
                this.context.error = error
                this.isProcessing = false
            })

            SCREEN_RECORDER.on('stopped', async () => {
                console.info('ScreenRecorder stopped - recording completed')
            })
            
            console.info('ScreenRecorder event listeners configured')
        } else {
            console.info('RECORDING disabled - skipping screen recorder event listeners')
        }

        console.info('Event listeners setup complete')
    }

    private async checkEndConditions(): Promise<{
        shouldEnd: boolean
        reason?: RecordingEndReason
    }> {
        const checkPromise = async () => {
            const now = Date.now()

            try {
                // Check if stop was requested via state machine
                if (this.context.endReason) {
                    return { shouldEnd: true, reason: this.context.endReason }
                }

                // Check if bot was removed
                if (await this.checkBotRemoved()) {
                    return {
                        shouldEnd: true,
                        reason: RecordingEndReason.BotRemoved,
                    }
                }

                // Check participants
                if (await this.checkNoAttendees(now)) {
                    return {
                        shouldEnd: true,
                        reason: RecordingEndReason.NoAttendees,
                    }
                }

                // Check audio activity
                if (await this.checkNoSpeaker(now)) {
                    return {
                        shouldEnd: true,
                        reason: RecordingEndReason.NoSpeaker,
                    }
                }

                return { shouldEnd: false }
            } catch (error) {
                console.error('Error checking end conditions:', error)
                return {
                    shouldEnd: true,
                    reason: RecordingEndReason.BotRemoved,
                }
            }
        }

        const timeoutPromise = new Promise<{
            shouldEnd: boolean
            reason?: RecordingEndReason
        }>((_, reject) =>
            setTimeout(
                () => reject(new Error('Check end conditions timeout')),
                5000,
            ),
        )

        try {
            return await Promise.race([checkPromise(), timeoutPromise])
        } catch (error) {
            console.error('Error or timeout in checkEndConditions:', error)
            return { shouldEnd: true, reason: RecordingEndReason.BotRemoved }
        }
    }

    private async handleMeetingEnd(reason: RecordingEndReason): Promise<void> {
        console.info(`Handling meeting end with reason: ${reason}`)
        this.context.endReason = reason

        try {
            // Stop the dialog observer
            this.stopDialogObserver()

            // Try to close the meeting but don't let an error here affect the rest
            try {
                // If the reason is bot_removed, we know the meeting is already effectively closed
                if (reason === RecordingEndReason.BotRemoved) {
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

            console.info('Stopping video recording')
            await this.stopVideoRecording().catch((err) => {
                console.error(
                    'Error stopping video recording, continuing:',
                    err,
                )
            })

            console.info('Stopping audio streaming')
            await this.stopAudioStreaming().catch((err) => {
                console.error(
                    'Error stopping audio streaming, continuing:',
                    err,
                )
            })

            console.info('Stopping screen recorder')
            try {
                if (RECORDING && SCREEN_RECORDER.isCurrentlyRecording()) {
                    await SCREEN_RECORDER.stopRecording()
                    console.info('ScreenRecorder stopped successfully')
                } else {
                    console.info('RECORDING disabled or not recording - skipping screen recorder stop')
                }
            } catch (error) {
                console.error(
                    'Error stopping screen recorder, continuing cleanup:',
                    error,
                )
            }

            console.info('Setting isProcessing to false to end recording loop')
            await this.sleep(2000)
        } catch (error) {
            console.error('Error during meeting end handling:', error)
        } finally {
            // Always ensure this flag is set to stop the processing loop
            this.isProcessing = false
            console.info('Meeting end handling completed')
        }
    }

    private async stopVideoRecording(): Promise<void> {
        if (!RECORDING) {
            console.log('RECORDING disabled - skipping video recording stop')
            return
        }

        // Utiliser ScreenRecorder pour arrêter l'enregistrement
        if (this.context.screenRecorder) {
            try {
                if (this.context.screenRecorder.isCurrentlyRecording()) {
                    console.log('Stopping screen recording via ScreenRecorder...')
                    await this.context.screenRecorder.stopRecording()
                    console.log('Screen recording stopped successfully')
                } else {
                    console.log('Screen recording was not active')
                }
                return
            } catch (error) {
                console.error('Error stopping screen recording:', error)
                throw error
            }
        } else {
            console.warn('ScreenRecorder not available - recording may not have been properly started')
        }
    }

    private async stopAudioStreaming(): Promise<void> {
        if (!RECORDING) {
            console.info('RECORDING disabled - skipping audio streaming stop')
            return
        }

        if (!this.context.backgroundPage) {
            console.error('Background page not available for stopping audio')
            return
        }

        try {
            await this.context.backgroundPage.evaluate(() => {
                const w = window as any
                return w.stopAudioStreaming()
            })
            console.info('Audio streaming stopped successfully')
        } catch (error) {
            console.error('Failed to stop audio streaming:', error)
            throw error
        }
    }

    private async checkBotRemoved(): Promise<boolean> {
        if (!this.context.playwrightPage) {
            console.error('Playwright page not available')
            return true
        }

        try {
            return await this.context.provider.findEndMeeting(
                this.context.params,
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
        // Si RECORDING=false, pas de streaming audio donc pas de vérification de son
        if (!RECORDING) {
            return false
        }

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

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }
}

