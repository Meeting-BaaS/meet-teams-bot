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
import {
    MeetingEndReason,
    MeetingStateType,
    NetworkFallbackController,
    StateExecuteResult,
} from '../types'
import { BaseState } from './base-state'
import { formatError } from '../../utils/Logger'
import { sendEntryMessage } from '../../meeting/meet'
import { verifyMeetAudioCapture } from '../../meeting/meet/audio-capture'

export class InCallState extends BaseState implements NetworkFallbackController {
    private isStartingUIObserver = false
    private teamsNetworkFallbackTriggered: boolean = false
    private meetNetworkFallbackTriggered: boolean = false
    // Set once ANY fallback is requested (including by the diarization health
    // monitor for a provider without a node-side network path, e.g. Zoom), so
    // repeated monitor triggers are idempotent.
    private diarizationFallbackRequested: boolean = false
    private meetAudioEventCount = 0
    private meetAudioWatchdog?: ReturnType<typeof setInterval>
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

        // Expose this state's network-fallback machinery so the diarization
        // health monitor (which runs later, in RecordingState) can drive the
        // same instance-flag fallback path this state owns.
        this.context.networkFallback = this

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
                    // Also start the UI observer as an early-window BRIDGE. At
                    // first speech after silence the speaker's audio track takes
                    // seconds to spin up before the network path can attribute
                    // anything, while Meet's UI indicator fires almost
                    // immediately — that gap produced leading "Unknown" runs.
                    // The SpeakerManager arbiter mutes this source once the
                    // network path reports its first speaker. Non-blocking:
                    // opening the People panel can take seconds and must not
                    // delay the recording-started event.
                    this.startUIBasedObservation().catch((error) => {
                        console.warn(
                            '[SpeakerBridge] UI bridge failed to start (network path still active):',
                            formatError(error),
                        )
                    })
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

                if (payload.source === 'audio') {
                    this.meetAudioEventCount++
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

                // Label which source drove this committed update, so the bot
                // log distinguishes the dcrpc datachannel (NetEq) path from the
                // CSRC audio path. dcrpc payloads ride the same source: "audio"
                // channel and already feed the audio-path watchdog below via
                // meetAudioEventCount, holding the network path on NetEq.
                const speakerSource = payload.dcrpc
                    ? 'network:dcrpc'
                    : `network:${payload.source ?? 'audio'}`
                await SpeakerManager.getInstance().handleNetworkSpeakerUpdate(
                    networkUsers,
                    payload.timestamp,
                    speakerSource,
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

        // Audio-path watchdog: setup success only proves the hooks were
        // installed, not that they see Meet's audio track layer. Observed live
        // (bot 34266844): roster decoded, sound recorded, but tracks=0 the
        // whole meeting and NO failure event fired — the exact silent
        // blindness the Teams path had. If no audio-source event arrives
        // within the grace window while the call is live, retire the network
        // path and hand observation to the UI observer, which is proven on
        // current Meet markup.
        const MEET_AUDIO_DEAD_AFTER_MS = 45_000
        let watchdogStart = Date.now()
        this.meetAudioEventCount = 0
        this.meetAudioWatchdog = setInterval(() => {
            void (async () => {
                try {
                    if (this.meetNetworkFallbackTriggered) {
                        clearInterval(this.meetAudioWatchdog)
                        return
                    }
                    if (this.meetAudioEventCount > 0) {
                        clearInterval(this.meetAudioWatchdog)
                        console.log(
                            '[MeetNetworkInterceptor] ✅ Audio path alive — watchdog disarmed',
                        )
                        return
                    }
                    // Sound-gated: this watchdog exists to catch the tracks=0
                    // blindness where sound IS flowing but no audio-source event
                    // fires. On a silent open there is simply no audio yet, so
                    // firing here would retire a healthy native path that has
                    // nothing to expose — and force-native CSRC cannot re-arm
                    // after the switch to the UI observer (blind under
                    // CloakBrowser), stranding the bot when speech finally
                    // starts. While no real sound has been detected, keep
                    // resetting the clock so the 45s "blind" window only measures
                    // time WITH audio present; the path stays armed and gets a
                    // fresh 45s once speech begins.
                    if (!GLOBAL.getSoundDetectedInMeeting()) {
                        watchdogStart = Date.now()
                        return
                    }
                    if (Date.now() - watchdogStart < MEET_AUDIO_DEAD_AFTER_MS) {
                        return
                    }
                    clearInterval(this.meetAudioWatchdog)
                    this.meetNetworkFallbackTriggered = true
                    console.warn(
                        `[MeetNetworkInterceptor] 🚨 No audio-source event after ${MEET_AUDIO_DEAD_AFTER_MS / 1000}s — retiring network path, switching to UI observer`,
                    )
                    await meetNetworkInterception.stopNetworkInterception(
                        this.context.playwrightPage as Page,
                    )
                    await this.startUIBasedObservation()
                } catch (error) {
                    console.error(
                        '[MeetNetworkInterceptor] watchdog error:',
                        formatError(error),
                    )
                }
            })()
        }, 5_000)

        return true
    }

    private async startUIBasedObservation(): Promise<void> {
        if (this.isStartingUIObserver) {
            console.log('UI speakers observer startup already in progress')
            return
        }
        // Already running (e.g. started as the Meet bridge, now re-requested by
        // the watchdog fallback) — don't spin up a second observer.
        if (this.context.speakersObserver) {
            console.log('UI speakers observer already running')
            return
        }

        this.isStartingUIObserver = true

        try {
            // Create and start integrated speakers observer
            const speakersObserver = new SpeakersObserver(
                GLOBAL.get().meetingProvider,
            )

            // Callback to handle speakers changes. On Meet the observer may run
            // as an early-window BRIDGE alongside a live network path, so route
            // it through the arbiter: it feeds diarization only until the
            // network path reports its first speaker (or the network path is
            // retired by the watchdog, in which case this observer is primary).
            // Teams has its own pause-based fallback and feeds directly.
            const onSpeakersChange = async (speakers: any[]) => {
                try {
                    if (GLOBAL.get().meetingProvider === 'Meet') {
                        await SpeakerManager.getInstance().handleUiBridgeUpdate(
                            speakers,
                            this.meetNetworkFallbackTriggered,
                        )
                    } else {
                        await SpeakerManager.getInstance().handleSpeakerUpdate(
                            speakers,
                            'ui-observer',
                        )
                    }
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

    /**
     * NetworkFallbackController: true once a network→UI fallback has already
     * been requested through ANY path (in-page audio-path watchdog, Meet audio
     * watchdog, or the diarization health monitor).
     */
    public isFallbackTriggered(): boolean {
        return (
            this.diarizationFallbackRequested ||
            this.teamsNetworkFallbackTriggered ||
            this.meetNetworkFallbackTriggered
        )
    }

    /**
     * NetworkFallbackController: retire the network speaker path and hand
     * observation to the UI observer. Idempotent. Sets the SAME instance flags
     * the existing watchdogs use, so the network straggler-drop guards and the
     * Meet UI bridge (handleUiBridgeUpdate) keep working. Invoked by the
     * diarization health monitor once the network path has been stale past the
     * platform dwell.
     */
    public async requestFallback(reason: string): Promise<void> {
        if (this.isFallbackTriggered()) {
            return
        }
        this.diarizationFallbackRequested = true
        const provider = GLOBAL.get().meetingProvider
        console.warn(
            `[NetworkFallback][${provider}] Retiring network path (reason: ${reason}) — switching to UI-based speaker observation`,
        )
        try {
            if (provider === 'Teams') {
                this.teamsNetworkFallbackTriggered = true
                const { pauseTeamsNetworkInterception } = await import(
                    '../../meeting/teams/network-interception'
                )
                pauseTeamsNetworkInterception()
            } else if (provider === 'Meet') {
                this.meetNetworkFallbackTriggered = true
                if (this.context.playwrightPage) {
                    const meetNetworkInterception = await import(
                        '../../meeting/meet/network-interception'
                    )
                    await meetNetworkInterception.stopNetworkInterception(
                        this.context.playwrightPage as Page,
                    )
                }
            }
            // Zoom (and any other provider) already runs on the UI observer from
            // setup — there is no node-side network path to retire — so this
            // just (re)starts it, which is a no-op if already running.
            await this.startUIBasedObservation()
        } catch (error) {
            console.error(
                `[NetworkFallback][${provider}] Failed to retire network path:`,
                formatError(error),
            )
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
