import { Events } from '../../events'
import { HtmlCleaner } from '../../meeting/htmlCleaner'
import { SpeakersObserver } from '../../meeting/speakersObserver'
import { ScreenRecorderManager } from '../../recording/ScreenRecorder'
import { GLOBAL } from '../../singleton'
import { SpeakerManager } from '../../speaker-manager'
import { MEETING_CONSTANTS } from '../constants'
import { MeetingStateType, StateExecuteResult } from '../types'
import { BaseState } from './base-state'
import { formatError } from '../../utils/Logger'
import { sendEntryMessage } from '../../meeting/meet'
import { verifyMeetAudioCapture } from '../../meeting/meet/audio-capture'

export class InCallState extends BaseState {
    async execute(): StateExecuteResult {
        const startTime = Date.now()
        console.info(`[InCallState] Starting execute() at ${new Date(startTime).toISOString()}`)

        try {
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

        try {
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


            // OPTIMIZATION: Start HTML Cleaner FIRST to surface video on top
            // This ensures video is at z-index: 900000 before other actions
            await this.startHtmlCleaning()

            // Start speakers observation in all cases
            // Speakers observation is independent of video recording
            try {
                await this.startSpeakersObservation()
            } catch (error) {
                console.error(
                    'Failed to start speakers observation:',
                    formatError(error),
                )
                // Continue even if speakers observation fails
            }

            // OPTIMIZATION: Move entry message and audio verification to async (non-blocking)
            // These run after video is surfaced and recording has started
            this.performNonBlockingActions().catch((err) => {
                console.error(
                    'Error in non-blocking actions:',
                    formatError(err),
                )
            })

            // Notify that recording has started
            Events.inCallRecording({ start_time: this.context.startTime })
        } catch (error) {
            console.error(
                'Error in setupBrowserComponents:',
                formatError(error, {
                    hasPlaywrightPage: !!this.context.playwrightPage,
                    recordingMode: GLOBAL.get().recording_mode,
                    meetingProvider: GLOBAL.get().meetingProvider,
                    botName: GLOBAL.get().bot_name,
                }),
            )
            throw new Error(`Browser component setup failed: ${error as Error}`)
        }
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

        // Create and start integrated speakers observer
        const speakersObserver = new SpeakersObserver(
            GLOBAL.get().meetingProvider,
        )

        // Callback to handle speakers changes
        const onSpeakersChange = async (speakers: any[]) => {
            try {
                await SpeakerManager.getInstance().handleSpeakerUpdate(speakers)
            } catch (error) {
                console.error('Error handling speaker update:', formatError(error))
            }
        }

        try {
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
