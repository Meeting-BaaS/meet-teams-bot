import type { Page } from '@playwright/test'
import { Events } from '../../events'
import { HtmlCleaner } from '../../meeting/htmlCleaner'
import { SpeakersObserver } from '../../meeting/speakersObserver'
import type {
    NetworkPayload,
    NetworkUser,
} from '../../meeting/teams/network-interception/types'
import type { NetworkPayload as MeetNetworkPayload } from '../../meeting/meet/network-interception/types'
import { ScreenRecorderManager } from '../../recording/ScreenRecorder'
import { GLOBAL } from '../../singleton'
import { SpeakerManager } from '../../speaker-manager'
import { MEETING_CONSTANTS } from '../constants'
import { MeetingEndReason, MeetingStateType, StateExecuteResult } from '../types'
import { BaseState } from './base-state'
import { formatError } from '../../utils/Logger'
import { sendEntryMessage } from '../../meeting/meet'
import { verifyMeetAudioCapture } from '../../meeting/meet/audio-capture'

export class InCallState extends BaseState {
    private isStartingUIObserver = false
    private teamsNetworkFallbackTriggered: boolean = false
    private meetNetworkFallbackTriggered: boolean = false
    private lastNetworkSpeakingKey?: string

    async execute(): StateExecuteResult {
        const startTime = Date.now()
        console.info(`[InCallState] Starting execute() at ${new Date(startTime).toISOString()}`)

        try {
            // Quick check: if stop was already requested before entering InCall, skip setup entirely
            if (GLOBAL.getEndReason() === MeetingEndReason.ExitingMeetingBeforeRecord) {
                console.info(`[InCallState] Stop already requested — skipping setup`)
                return this.handleError(new Error('Stop requested before recording setup'))
            }

            // Start with global timeout for setup
            await Promise.race([this.setupRecording(), this.createTimeout()])

            const duration = Date.now() - startTime
            console.info(`[InCallState] Setup completed successfully in ${duration}ms`)
            return this.transition(MeetingStateType.Recording)
        } catch (error) {
            const duration = Date.now() - startTime
            console.error(
                `[InCallState] Setup recording failed after ${duration}ms`,
                formatError(error),
            )
            return this.handleError(error as Error)
        }
    }

    private createTimeout(): Promise<never> {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(
                    new Error(
                        'Setup timeout: Recording sequence took too long',
                    ),
                )
            }, MEETING_CONSTANTS.SETUP_TIMEOUT)
        })
    }

    private async setupRecording(): Promise<void> {
        try {
            console.info('Starting recording setup sequence')

            // Notifier qu'on est en appel mais pas encore en enregistrement
            Events.inCallNotRecording()

            // Initialize services
            await this.initializeServices()

            // Clean HTML and start observation
            await this.setupBrowserComponents()

            console.info('Recording setup completed successfully')
        } catch (error) {
            console.error('Failed during recording setup:', formatError(error))
            throw error
        }
    }

    private async initializeServices(): Promise<void> {
        console.info('Initializing services')

        if (!this.context.pathManager) {
            throw new Error('PathManager not initialized')
        }
        console.info('Services initialized successfully')
    }

    private async setupBrowserComponents(): Promise<void> {
        if (!this.context.playwrightPage) {
            throw new Error('Playwright page not initialized')
        }

        console.log(
            'Setting up browser components with integrated HTML cleanup...',
        )

        // Set meetingStartTime for clean video output
        // This is set here (not in joinMeeting) to ensure clean video output
        const startTime = Date.now()
        this.context.startTime = startTime
        ScreenRecorderManager.getInstance().setMeetingStartTime(startTime)
        console.log(
            `Meeting start time set to: ${startTime} (${new Date(startTime).toISOString()})`,
        )

        // Make HTML cleanup and speaker observation non-blocking so as to avoid
        // aborting a valid recording when Teams' page is slow, broken, or
        // unresponsive during setup. RecordingState owns leave decisions.
        void this.startHtmlCleaning()
            .catch((error) =>
                console.error(
                    'HTML cleanup failed (non-fatal, continuing):',
                    formatError(error),
                ),
            )

        void this.startSpeakersObservation().catch((error) =>
            console.error(
                'Speakers observation failed (non-fatal, continuing):',
                formatError(error),
            ),
        )

        // OPTIMIZATION: Move entry message and audio verification to async (non-blocking)
        // These run after video is surfaced and recording has started
        this.performNonBlockingActions().catch((err) => {
            console.error(
                'Error in non-blocking actions:',
                formatError(err),
            )
        })

        // Final gate: if a stop request arrived during setup, bail out
        // before firing the recording event and transitioning to Recording state
        if (GLOBAL.getEndReason() === MeetingEndReason.ExitingMeetingBeforeRecord) {
            throw new Error('Stop requested during recording setup — exiting before record')
        }

        // Notify that recording has started
        Events.inCallRecording({ start_time: this.context.startTime })
    }

    /**
     * OPTIMIZATION: Non-blocking actions that run after critical setup
     * - Entry message (if configured)
     * - Audio verification (if streaming enabled)
     */
    private async performNonBlockingActions(): Promise<void> {
        if (!this.context.playwrightPage) {
            return
        }

        // Only for Meet provider
        if (GLOBAL.get().meetingProvider !== 'Meet') {
            return
        }

        // 1. Verify audio capture (if streaming enabled)
        if (GLOBAL.get().streaming_output) {
            try {
                await verifyMeetAudioCapture(this.context.playwrightPage)
            } catch (error) {
                console.error(
                    '[Meet] Failed to verify audio capture post-join:',
                    formatError(error),
                )
            }
        }

        // 2. Send entry message (if configured) - non-blocking
        if (GLOBAL.get().enter_message) {
            console.log('Sending entry message (non-blocking)...')
            sendEntryMessage(
                this.context.playwrightPage,
                GLOBAL.get().enter_message,
            ).catch((error) => {
                console.error(
                    'Failed to send entry message:',
                    formatError(error),
                )
            })
        }
    }

    private async startSpeakersObservation(): Promise<void> {
        console.log(
            `Starting speakers observation for ${GLOBAL.get().meetingProvider}`,
        )

        // Start SpeakerManager
        SpeakerManager.start()

        if (!this.context.playwrightPage) {
            console.error(
                'Playwright page not available for speakers observation',
            )
            return
        }

        if (GLOBAL.get().meetingProvider === 'Teams') {
            try {
                const networkSetupSuccess =
                    await this.tryTeamsNetworkInterception()
                if (networkSetupSuccess) {
                    console.log(
                        '✅ Network-based speaker detection enabled for Teams',
                    )
                    return
                }
            } catch (error) {
                console.warn(
                    '⚠️ Teams network speaker detection failed, falling back to UI-based detection:',
                    formatError(error),
                )
            }
        }

        if (GLOBAL.get().meetingProvider === 'Meet') {
            try {
                const networkSetupSuccess =
                    await this.tryMeetNetworkInterception()
                if (networkSetupSuccess) {
                    console.log(
                        '✅ Network-based speaker detection enabled for Meet',
                    )
                    return
                }
            } catch (error) {
                console.warn(
                    '⚠️ Meet network speaker detection failed, falling back to UI-based detection:',
                    formatError(error),
                )
            }
        }

        await this.startUIBasedObservation()
    }

    private async tryTeamsNetworkInterception(): Promise<boolean> {
        if (!this.context.playwrightPage) {
            return false
        }

        const teamsNetworkInterception = await import(
            '../../meeting/teams/network-interception'
        )
        const onNetworkSpeakersChange = async (payload: NetworkPayload) => {
            try {
                // In-page watchdog verdict: audio sub-path (dsh/CSRC) is dead
                // while the meeting is active. Gate further network payloads
                // and fall back to UI-based observation — once.
                if (payload.audioPathDead) {
                    if (!this.teamsNetworkFallbackTriggered) {
                        this.teamsNetworkFallbackTriggered = true
                        console.warn(
                            '[NetworkSpeaker][Teams] 🚨 Audio path dead — switching to UI-based speaker observation',
                        )
                        const { pauseTeamsNetworkInterception } = await import(
                            '../../meeting/teams/network-interception'
                        )
                        pauseTeamsNetworkInterception()
                        await this.startUIBasedObservation()
                    }
                    return
                }
                const networkUsers = payload.users as NetworkUser[]
                const speakingNames = networkUsers
                    .filter((u) => u.isSpeaking)
                    .map((u) => u.name)
                const speakingKey = speakingNames.slice().sort().join('|')
                if (speakingKey !== this.lastNetworkSpeakingKey) {
                    this.lastNetworkSpeakingKey = speakingKey
                    console.log(
                        `[NetworkSpeaker][Teams] 🗣️ speaking=[${speakingNames.join(', ') || '(none)'}] source=${payload.source} participants=${networkUsers.length}`,
                    )
                }

                await SpeakerManager.getInstance().handleNetworkSpeakerUpdate(
                    networkUsers,
                    payload.timestamp,
                )
            } catch (error) {
                console.error(
                    'Error handling Teams network speaker update:',
                    formatError(error),
                )
            }
        }

        const success =
            await teamsNetworkInterception.setupTeamsNetworkInterceptionCallback(
                this.context.playwrightPage as Page,
                onNetworkSpeakersChange,
            )
        if (!success) {
            return false
        }

        const verified =
            await teamsNetworkInterception.verifyTeamsNetworkInterception(
                this.context.playwrightPage as Page,
            )
        if (!verified) {
            console.warn(
                '[Teams NetworkInterceptor] Browser interceptor verification failed',
            )
            return false
        }

        return true
    }

    private async tryMeetNetworkInterception(): Promise<boolean> {
        if (!this.context.playwrightPage) {
            return false
        }

        const meetNetworkInterception = await import(
            '../../meeting/meet/network-interception'
        )
        const onNetworkSpeakersChange = async (
            payload: MeetNetworkPayload,
        ) => {
            try {
                // A track-level failure retires the whole network path on v1:
                // there is no stale-diarization monitor here to arbitrate, so
                // the safe behaviour is the pre-dd63960b one — fall back to
                // UI-based observation once. With the liveness fix in the
                // bundle, silence no longer produces these signals, so a
                // failure is a genuinely dead pipeline component.
                if (
                    payload.source === 'network_interception_failed' &&
                    payload.failure
                ) {
                    const { trackId, reason, trackState } = payload.failure
                    console.warn(
                        `[MeetNetworkInterceptor] ❌ Track ${trackId} failed: ${reason} (state: ${trackState})`,
                    )
                    if (!this.meetNetworkFallbackTriggered) {
                        this.meetNetworkFallbackTriggered = true
                        console.warn(
                            '[MeetNetworkInterceptor] 🔄 Falling back to UI-based speaker detection',
                        )
                        await meetNetworkInterception.stopNetworkInterception(
                            this.context.playwrightPage as Page,
                        )
                        await this.startUIBasedObservation()
                    }
                    return
                }

                if (payload.source === 'health_check' && payload.health) {
                    const { subscribed, activeTrackCount } = payload.health
                    console.log(
                        `[MeetNetworkInterceptor] Health: subscribed=${subscribed}, tracks=${activeTrackCount}`,
                    )
                    return
                }

                // Once the UI observer has taken over, drop network payloads
                // so the two paths cannot double-report speakers.
                if (this.meetNetworkFallbackTriggered) {
                    return
                }

                const networkUsers = payload.users as NetworkUser[]
                const speakingNames = networkUsers
                    .filter((u) => u.isSpeaking)
                    .map((u) => u.name)
                const speakingKey = speakingNames.slice().sort().join('|')
                if (speakingKey !== this.lastNetworkSpeakingKey) {
                    this.lastNetworkSpeakingKey = speakingKey
                    console.log(
                        `[NetworkSpeaker][Meet] 🗣️ speaking=[${speakingNames.join(', ') || '(none)'}] source=${payload.source} participants=${networkUsers.length}`,
                    )
                }

                await SpeakerManager.getInstance().handleNetworkSpeakerUpdate(
                    networkUsers,
                    payload.timestamp,
                )
            } catch (error) {
                console.error(
                    'Error handling Meet network speaker update:',
                    formatError(error),
                )
            }
        }

        const success =
            await meetNetworkInterception.setupNetworkInterceptionCallback(
                this.context.playwrightPage as Page,
                onNetworkSpeakersChange,
            )
        if (!success) {
            return false
        }

        const verified =
            await meetNetworkInterception.verifyNetworkInterception(
                this.context.playwrightPage as Page,
            )
        if (!verified) {
            console.warn(
                '[MeetNetworkInterceptor] Browser interceptor verification failed',
            )
            return false
        }

        return true
    }

    private async startUIBasedObservation(): Promise<void> {
        if (this.isStartingUIObserver) {
            console.log('UI speakers observer startup already in progress')
            return
        }

        this.isStartingUIObserver = true

        try {
            // Create and start integrated speakers observer
            const speakersObserver = new SpeakersObserver(
                GLOBAL.get().meetingProvider,
            )

            // Callback to handle speakers changes
            const onSpeakersChange = async (speakers: any[]) => {
                try {
                    await SpeakerManager.getInstance().handleSpeakerUpdate(
                        speakers,
                    )
                } catch (error) {
                    console.error(
                        'Error handling speaker update:',
                        formatError(error),
                    )
                }
            }

            await speakersObserver.startObserving(
                this.context.playwrightPage,
                GLOBAL.get().recording_mode,
                GLOBAL.get().bot_name,
                onSpeakersChange,
            )

            // Store the observer in context for cleanup later
            this.context.speakersObserver = speakersObserver

            console.log('Integrated speakers observer started successfully')
        } catch (error) {
            console.error(
                'Failed to start integrated speakers observer:',
                error,
            )
            throw error
        } finally {
            this.isStartingUIObserver = false
        }
    }

    private async startHtmlCleaning(): Promise<void> {
        if (!this.context.playwrightPage) {
            console.error('Playwright page not available for HTML cleanup')
            return
        }

        console.log(`Starting HTML cleanup for ${GLOBAL.get().meetingProvider}`)

        try {
            // EXACT SAME LOGIC AS EXTENSION: Use centralized HtmlCleaner
            const htmlCleaner = new HtmlCleaner(
                this.context.playwrightPage,
                GLOBAL.get().meetingProvider,
                GLOBAL.get().recording_mode,
            )

            await htmlCleaner.start()

            // Store for cleanup later
            this.context.htmlCleaner = htmlCleaner

            console.log('HTML cleanup started successfully')
        } catch (error) {
            console.error('Failed to start HTML cleanup:', formatError(error))
            // Continue even if HTML cleanup fails - it's not critical
        }
    }
}
