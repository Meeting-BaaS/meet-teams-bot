import { Events } from '../../events'
import { formatError } from '../../utils/Logger'
import { MEETING_CONSTANTS } from '../constants'

import {
    MeetingEndReason,
    MeetingStateType,
    StateExecuteResult,
} from '../types'
import { BaseState } from './base-state'

import { Api } from '../../api/methods'
import {
    AudioWarningEvent,
    ScreenRecorderManager,
} from '../../recording/ScreenRecorder'
import { GLOBAL } from '../../singleton'
import { SpeakerManager } from '../../speaker-manager'
import { uploadTranscriptTask } from '../../uploadTranscripts'
import { sleep } from '../../utils/sleep'
import { SoundLevelMonitor } from '../../utils/sound-level-monitor'
import { MeetingStateMachine } from '../machine'

// Sound level threshold for considering activity (0-100)
const SOUND_LEVEL_ACTIVITY_THRESHOLD = 5

// How long the bot must be alone (no other attendees + no sound) before leaving
const ALONE_IN_MEETING_TIMEOUT_MS = 30_000
// Speaker observer is considered healthy if a callback was received within this window
const SPEAKER_OBSERVER_HEALTH_WINDOW_MS = 10 * 60 * 1000 // 10 minutes
// Don't activate alone-in-meeting within the first 5 minutes of recording.
// The speaker observer can be unreliable at meeting start (especially on Teams),
// and brief false-positive attendee counts can pass the participantsEverSeen gate.
const ALONE_IN_MEETING_GRACE_PERIOD_MS = 5 * 60 * 1000

// Timeout for bot removal check - Teams needs more time due to isRemovedFromTheMeeting
// which calls ensurePageLoaded (20s) + button search, while Meet is faster
const getBotRemovalCheckTimeout = (): number => {
    const provider = GLOBAL.get().meetingProvider
    return provider === 'Teams' ? 40000 : 25000 // Teams: 40s, Meet: 25s (sufficient for page.content())
}

// Window for checking recent speaker callbacks when timeout occurs
// Use a wider window for Teams to avoid false positives when page is slow but still active
const getSpeakerCallbackCheckWindow = (): number => {
    const provider = GLOBAL.get().meetingProvider
    return provider === 'Teams' ? 60000 : 30000 // Teams: 60s, Meet: 30s
}

export class RecordingState extends BaseState {
    private isProcessing: boolean = true
    private readonly CHECK_INTERVAL = 250
    private lastSoundActivity: number = Date.now()
    private lastSoundActivityLogTime: number = 0
    private lastSoundMonitorInactiveLogTime: number = 0
    private lastNoOneJoinedPeriodLog: number = 0
    private lastNoSpeakerLogTime: number = 0
    private hasNoOneJoinedPeriodEnded: boolean = false
    private aloneInMeetingSince: number | null = null

    async execute(): StateExecuteResult {
        try {
            console.info('Starting recording state')

            // Initialize recording
            await this.initializeRecording()

            // Set a global timeout for the recording state
            const startTime = Date.now()
            // Note: startTime is already set in in-call state to prevent race conditions
            // Only set it here if it wasn't set earlier (fallback)
            if (!this.context.startTime) {
                this.context.startTime = startTime
                ScreenRecorderManager.getInstance().setMeetingStartTime(
                    startTime,
                )
                console.log(
                    'Fallback: Meeting start time set in recording state',
                )
            }

            // Initialize noSpeakerDetectedTime if not already set (for meetings with no participants)
            if (!this.context.noSpeakerDetectedTime) {
                this.context.noSpeakerDetectedTime = startTime
            }

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
                    // Set exit time immediately when meeting end is detected (before cleanup)
                    const exitTime = Math.floor(Date.now() / 1000)
                    GLOBAL.setExitTime(exitTime)
                    console.log(
                        `Bot exit time set to ${exitTime} (meeting end detected)`,
                    )

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
            console.error('❌ Error in recording state:', formatError(error))
            return this.handleError(error as Error)
        }
    }

    private async initializeRecording(): Promise<void> {
        console.info('Initializing recording...')

        // Log the context state
        console.info('Context state:', {
            hasPathManager: !!this.context.pathManager,
            hasStreamingService: !!this.context.streamingService,
            isSoundLevelMonitorActive: SoundLevelMonitor.peekInstance()?.getIsActive() ?? false,
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
            console.error('ScreenRecorder error:', formatError(error))

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
            const botRemovalTimeout = getBotRemovalCheckTimeout()
            const botRemovedResult = await Promise.race([
                this.checkBotRemoved(),
                new Promise<boolean>((_, reject) =>
                    setTimeout(
                        () => reject(new Error('Bot removed check timeout')),
                        botRemovalTimeout,
                    ),
                ),
            ])

            if (botRemovedResult) {
                return this.getBotRemovedReason()
            }

            // Check for sound activity first - if detected, mark it and reset silence timers
            // Uses SoundLevelMonitor (independent of streaming)
            const monitor = SoundLevelMonitor.peekInstance()

            if (!monitor || !monitor.getIsActive()) {
                // Throttle to avoid log spam in 250ms loop
                if (now - this.lastSoundMonitorInactiveLogTime >= 30_000) {
                    console.warn(
                        '[checkEndConditions] SoundLevelMonitor is not active - sound level detection may not work',
                    )
                    this.lastSoundMonitorInactiveLogTime = now
                }
            }

            const currentSoundLevel = monitor?.getCurrentSoundLevel() ?? 0
            
            if (currentSoundLevel > SOUND_LEVEL_ACTIVITY_THRESHOLD) {
                // Mark that sound has been detected (ends noone_joined grace period)
                if (!this.hasNoOneJoinedPeriodEnded) {
                    this.hasNoOneJoinedPeriodEnded = true
                    console.log(
                        `[checkEndConditions] First sound detected (${currentSoundLevel.toFixed(2)}), ending noone_joined_timeout grace period and enabling silence monitoring`,
                    )
                }
                
                // Only log once per 2 seconds to avoid spam (separate from silence timer)
                if (now - this.lastSoundActivityLogTime >= 2000) {
                    console.log(
                        `[checkEndConditions] Sound activity detected (${currentSoundLevel.toFixed(2)}), resetting lastSoundActivity silence timer`,
                    )
                    this.lastSoundActivityLogTime = now
                }
                
                // Reset the silence timer (this is the critical timer for automatic leave)
                this.lastSoundActivity = now
            }

            // Check if we're still in the noone_joined_period
            const noOneJoinedResult = this.checkNoOneJoined(now)
            if (noOneJoinedResult.shouldEnd) {
                return noOneJoinedResult
            }

            // If we get here, either:
            // 1. No one joined period has ended (sound or attendees detected) → enable silence monitoring
            // 2. Still in no one joined period (no sound/attendees yet, timeout not expired) → return false
            if (!this.hasNoOneJoinedPeriodEnded) {
                // Still waiting for first sound or attendees, no one joined period not over yet
                return { shouldEnd: false }
            }

            // Check if all human participants have left (bot is alone)
            // This triggers faster than silence_timeout when the speaker observer
            // confirms the bot is the only attendee remaining.
            const aloneResult = this.checkAloneInMeeting(now, currentSoundLevel)
            if (aloneResult.shouldEnd) {
                return aloneResult
            }

            // No one joined period is over - check silence timeout
            if (await this.checkNoSpeaker(now)) {
                return { shouldEnd: true, reason: MeetingEndReason.NoSpeaker }
            }

            return { shouldEnd: false }
        } catch (error) {
            console.error('Error checking end conditions:', formatError(error))

            // If it's a timeout checking bot removal, verify with secondary check
            const errorMessage = error instanceof Error ? error.message : String(error)
            if (errorMessage.includes('Bot removed check timeout')) {
                // Secondary check: if we've received speaker callbacks recently,
                // the page is still responsive - don't treat as bot removal
                const lastCallbackTime = SpeakerManager.getInstance().getLastCallbackTime()
                const timeSinceLastCallback = lastCallbackTime ? Date.now() - lastCallbackTime : null
                const callbackCheckWindow = getSpeakerCallbackCheckWindow()

                if (lastCallbackTime && timeSinceLastCallback !== null && timeSinceLastCallback < callbackCheckWindow) {
                    console.warn(
                        `Bot removal check timed out, but received speaker callback ${timeSinceLastCallback}ms ago - page still responsive, not treating as bot removal`
                    )
                    return { shouldEnd: false }
                }

                // If no recent callbacks, check if we have sound activity as another indicator
                const monitor = SoundLevelMonitor.peekInstance()
                const currentSoundLevel = monitor?.getCurrentSoundLevel() ?? 0
                if (currentSoundLevel > SOUND_LEVEL_ACTIVITY_THRESHOLD) {
                    console.warn(
                        `Bot removal check timed out, but sound activity detected (${currentSoundLevel.toFixed(2)}) - page likely still active, not treating as bot removal`
                    )
                    return { shouldEnd: false }
                }

                console.warn(
                    `Bot removal check timed out and no recent speaker callbacks (last: ${timeSinceLastCallback ? `${Math.round(timeSinceLastCallback / 1000)}s ago` : 'never'}) - treating as bot removal`
                )
                return this.getBotRemovedReason()
            }

            // For other errors, don't assume bot was removed - just retry next iteration
            return { shouldEnd: false }
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

            // Close final transcript before other cleanup steps
            await this.closeFinalTranscript()

            // These critical steps must execute regardless of previous steps
            console.info('Triggering call ended event')
            await Events.callEnded()

            console.info('Setting isProcessing to false to end recording loop')
        } catch (error) {
            console.error('Error during meeting end handling:', formatError(error))
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
            console.error('Error checking if bot was removed:', formatError(error))
            return false
        }
    }

    /**
     * Checks if the noone_joined_period should end the meeting due to no sound/attendees
     * No one joined period ends when:
     * - Sound is first detected, OR
     * - Attendees are detected via UI (positive signal only as layout is fickle, so we need to be sure), OR
     * - Timeout elapses (no sound and no attendees detected)
     * @param now Current timestamp
     * @returns Object indicating if meeting should end and reason
     */
    private checkNoOneJoined(now: number): {
        shouldEnd: boolean
        reason?: MeetingEndReason
    } {
        const startTime = this.context.startTime
        if (!startTime) {
            return { shouldEnd: false }
        }

        // Check for positive attendee signals (only use when true, not when false/0)
        // This helps when users are present but haven't spoken yet
        const attendeesCount = this.context.attendeesCount || 0
        const firstUserJoined = this.context.firstUserJoined || false

        // If grace period has already ended (by sound or attendees), return early
        if (this.hasNoOneJoinedPeriodEnded) {
            return { shouldEnd: false }
        }

        // If attendees detected via UI (positive signal), end grace period
        // We only use this when it's positive (count > 0 or firstUserJoined = true)
        // This way, if UI detection works, we use it; if it doesn't, we fall back to sound
        if (attendeesCount > 0 || firstUserJoined) {
            // Reset silence timer to start monitoring from now, even though no one joined was detected via UI
            // This is important to ensure that the silence timeout is not triggered too early
            this.lastSoundActivity = now
            console.log(
                `[noone-joined] Grace period ended (attendees detected via UI: count=${attendeesCount}, firstUserJoined=${firstUserJoined}), enabling silence timeout checks`,
            )
            this.hasNoOneJoinedPeriodEnded = true
            return { shouldEnd: false }
        }

        // Use noone_joined_timeout from config, with fallback to default
        const nooneJoinedTimeoutSeconds =
            GLOBAL.get().automatic_leave.noone_joined_timeout ??
            MEETING_CONSTANTS.DEFAULT_NOONE_JOINED_TIMEOUT_SECONDS
        const gracePeriodMs = nooneJoinedTimeoutSeconds * 1000
        const elapsed = now - startTime

        // If grace period hasn't elapsed yet, continue waiting
        if (elapsed < gracePeriodMs) {
            // Log at most every 30 seconds to avoid noisy logs
            if (now - this.lastNoOneJoinedPeriodLog >= 30_000) {
                const remainingSeconds = Math.ceil(
                    (gracePeriodMs - elapsed) / 1000,
                )
                console.log(
                    `[noone-joined] Waiting for first sound or attendees... ${remainingSeconds}s remaining before timeout`,
                )
                this.lastNoOneJoinedPeriodLog = now
            }
            return { shouldEnd: false }
        }

        // Grace period elapsed and no sound/attendees detected - exit with NoAttendees
        console.log(
            `[noone-joined] No sound or attendees detected during ${nooneJoinedTimeoutSeconds}s grace period, ending meeting with NoAttendees`,
        )
        return { shouldEnd: true, reason: MeetingEndReason.NoAttendees }
    }

    /**
     * Closes the final transcript segment with the exact meeting end time
     */
    private async closeFinalTranscript(): Promise<void> {
        if (GLOBAL.isServerless() || !Api.instance) {
            return
        }

        try {
            const speakerManager = SpeakerManager.getInstance()
            const currentSpeaker = speakerManager.getCurrentSpeaker()

            if (!currentSpeaker) {
                console.log('No current speaker to close final transcript')
                return
            }

            // Get exit time (when bot was removed/kicked) - already in seconds
            const exitTime = GLOBAL.get().exit_time
            if (!exitTime) {
                console.warn('Exit time not available, using current time')
                // Fallback to current time if exit_time not set
                const meetingStartTime =
                    MeetingStateMachine.instance.getStartTime()
                if (meetingStartTime) {
                    const currentTimeSeconds = Math.floor(Date.now() / 1000)
                    const endTimeRelative =
                        currentTimeSeconds - Math.floor(meetingStartTime / 1000)
                    await uploadTranscriptTask(
                        currentSpeaker,
                        true,
                        endTimeRelative,
                    )
                }
                return
            }

            // Calculate end_time relative to meeting start
            const meetingStartTime = MeetingStateMachine.instance.getStartTime()
            if (!meetingStartTime) {
                console.warn(
                    'Meeting start time not available for closing final transcript',
                )
                return
            }

            const meetingStartTimeSeconds = Math.floor(meetingStartTime / 1000)
            const endTimeRelative = exitTime - meetingStartTimeSeconds

            console.log(
                `Closing final transcript with exit time: ${exitTime} (relative: ${endTimeRelative}s)`,
            )
            await uploadTranscriptTask(currentSpeaker, true, endTimeRelative)
        } catch (error) {
            console.error('Failed to close final transcript:', formatError(error))
            // Don't throw - continue with cleanup even if this fails
        }
    }

    /**
     * Checks if the meeting should end due to absence of sound
     * @param now Current timestamp
     * @returns true if the meeting should end due to absence of sound
     */
    private checkNoSpeaker(now: number): boolean {
        // Check if the silence period has exceeded the timeout
        const silenceDurationSeconds = Math.floor(
            (now - this.lastSoundActivity) / 1000,
        )
        // Use the silence timeout from API (in seconds), or fallback to default if not provided
        const silenceTimeoutSeconds =
            GLOBAL.get().automatic_leave.silence_timeout ??
            MEETING_CONSTANTS.DEFAULT_SILENCE_TIMEOUT_SECONDS

        const shouldEnd = silenceDurationSeconds >= silenceTimeoutSeconds
        if (shouldEnd) {
            console.log(
                `[checkNoSpeaker] No sound activity detected for ${silenceDurationSeconds} seconds, ending meeting`,
            )
        } else {
            // Log when silence starts (0s) and then periodically every 30 seconds
            const timeSinceLastLog = now - this.lastNoSpeakerLogTime
            const shouldLog = 
                (silenceDurationSeconds === 0 && timeSinceLastLog >= 5000) || // Log once at 0s, but throttle to avoid spam (min 5s between logs)
                (silenceDurationSeconds > 0 && silenceDurationSeconds % 30 === 0 && timeSinceLastLog >= 30000) // Then every 30s
            
            if (shouldLog) {
                console.log(
                    `[checkNoSpeaker] No speaker detected for ${silenceDurationSeconds}s / ${silenceTimeoutSeconds}s`,
                )
                this.lastNoSpeakerLogTime = now
            }
        }
        return shouldEnd
    }

    /**
     * Checks if the bot is alone in the meeting (all human participants left).
     * Only trusts the attendee count when the speaker observer has been healthy
     * (received a callback within the last 10 minutes). If the observer is
     * unhealthy, this check is skipped and the bot falls back to silence_timeout.
     *
     * Requires ALL of these conditions to be true for 30 seconds:
     * 1. participantsEverSeen - At least one real participant was detected at some
     *    point during the meeting. This is a proof-of-life gate: it ensures the
     *    speaker observer is actually working and has successfully detected humans.
     *    Without this, a broken observer (e.g. after a UI change) that returns
     *    empty arrays but still fires callbacks would cause every bot to leave
     *    after 30s of silence. This check also separates alone-in-meeting from
     *    the noone_joined check, which handles the "nobody ever showed up" case.
     *    Note: v1 filters the bot from the speaker list, so any entry in the
     *    participant names list is a confirmed real human.
     * 2. isAlone - Current attendee count is 0 (v1 filters bot, so 0 = truly alone)
     * 3. isSilent - No meaningful audio activity (sound level <= 5)
     * 4. speakerObserverHealthy - Observer callback received within last 10 min
     */
    private checkAloneInMeeting(
        now: number,
        currentSoundLevel: number,
    ): { shouldEnd: boolean; reason?: MeetingEndReason } {
        const attendeesCount = this.context.attendeesCount || 0

        // Don't activate alone-in-meeting within the first 5 minutes of recording.
        // The speaker observer can be unreliable at meeting start (especially on Teams),
        // and brief false-positive attendee counts can pass the participantsEverSeen gate.
        const startTime = this.context.startTime
        if (startTime && now - startTime < ALONE_IN_MEETING_GRACE_PERIOD_MS) {
            return { shouldEnd: false }
        }

        // Gate: only activate alone-in-meeting if we've ever seen a real participant.
        // v1 filters the bot from the speaker list, so any entry in participantNames
        // is a confirmed real human who was in the meeting at some point.
        const participantsEverSeen = GLOBAL.getParticipantNames().length > 0
        if (!participantsEverSeen) {
            return { shouldEnd: false }
        }

        // Check if the speaker observer is healthy (received a callback recently)
        const lastCallbackTime = SpeakerManager.getInstance().getLastCallbackTime()
        const speakerObserverHealthy =
            lastCallbackTime !== null && now - lastCallbackTime < SPEAKER_OBSERVER_HEALTH_WINDOW_MS

        const isAlone = attendeesCount === 0 // v1 filters bot, so 0 = truly alone
        const isSilent = currentSoundLevel <= SOUND_LEVEL_ACTIVITY_THRESHOLD

        if (isAlone && isSilent && speakerObserverHealthy) {
            // Start or continue the "alone" countdown
            if (this.aloneInMeetingSince === null) {
                this.aloneInMeetingSince = now
                console.log(
                    `[alone-in-meeting] Bot appears to be alone (attendees=${attendeesCount}, sound=${currentSoundLevel.toFixed(2)}), starting ${ALONE_IN_MEETING_TIMEOUT_MS / 1000}s countdown`,
                )
            }

            const aloneForMs = now - this.aloneInMeetingSince
            if (aloneForMs >= ALONE_IN_MEETING_TIMEOUT_MS) {
                console.log(
                    `[alone-in-meeting] Bot has been alone for ${Math.floor(aloneForMs / 1000)}s with no sound, leaving meeting`,
                )
                return { shouldEnd: true, reason: MeetingEndReason.AllParticipantsLeft }
            }
        } else {
            // Reset the countdown if conditions no longer met
            if (this.aloneInMeetingSince !== null) {
                const resetReason = !isAlone
                    ? `attendees=${attendeesCount}`
                    : !isSilent
                      ? `sound=${currentSoundLevel.toFixed(2)}`
                      : 'speaker observer unhealthy'
                console.log(`[alone-in-meeting] Countdown reset (${resetReason})`)
                this.aloneInMeetingSince = null
            }
        }

        return { shouldEnd: false }
    }
}
