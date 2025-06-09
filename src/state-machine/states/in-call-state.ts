import { Events } from '../../events'
import { RECORDING } from '../../main'
import { TRANSCODER } from '../../recording/Transcoder'
import { SpeakerManager } from '../../speaker-manager'
import { MEETING_CONSTANTS } from '../constants'
import { MeetingStateType, StateExecuteResult } from '../types'
import { BaseState } from './base-state'

export class InCallState extends BaseState {
    async execute(): StateExecuteResult {
        try {
            // Start dialog observer upon entering the state
            this.startDialogObserver()

            // Start with global timeout for setup
            await Promise.race([this.setupRecording(), this.createTimeout()])
            return this.transition(MeetingStateType.Recording)
        } catch (error) {
            // Arrêter l'observateur en cas d'erreur
            this.stopDialogObserver()

            console.error('Setup recording failed:', error)
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
            console.error('Failed during recording setup:', error)
            throw error
        }
    }

    private async initializeServices(): Promise<void> {
        console.info('Initializing services')

        if (!this.context.pathManager) {
            throw new Error('PathManager not initialized')
        }

        // Seulement configurer et démarrer le transcoder si RECORDING est activé
        if (RECORDING) {
            // Configurer le transcoder avec le mode d'enregistrement
            TRANSCODER.configure(
                this.context.pathManager,
                this.context.params.recording_mode,
                this.context.params,
            )

            await TRANSCODER.start()
            console.info('Transcoder started successfully')
        } else {
            console.info('RECORDING disabled - skipping transcoder initialization')
        }

        console.info('Services initialized successfully')
    }

    private async setupBrowserComponents(): Promise<void> {
        if (!this.context.backgroundPage) {
            throw new Error('Background page not initialized')
        }

        try {
            // First check if the extension functions exist
            const functionsExist = await this.context.backgroundPage.evaluate(
                () => {
                    const w = window as any
                    return {
                        removeHtmlExists:
                            typeof w.remove_shitty_html === 'function',
                        speakersObserverExists:
                            typeof w.start_speakers_observer === 'function',
                    }
                },
            )

            console.log('Extension functions status:', functionsExist)

            // Only attempt to call functions that exist
            if (functionsExist.removeHtmlExists) {
                // Nettoyage du HTML
                await this.context.backgroundPage.evaluate(
                    async (params) => {
                        const w = window as any
                        await w.remove_shitty_html(
                            params.recording_mode,
                            params.meetingProvider,
                        )
                    },
                    {
                        recording_mode: this.context.params.recording_mode,
                        meetingProvider: this.context.params.meetingProvider,
                    },
                )
                console.log('HTML cleanup completed successfully')
            } else {
                console.warn(
                    'remove_shitty_html function not found in extension context',
                )
            }

            // Si RECORDING=false, démarrer immédiatement l'observation des speakers
            if (!RECORDING) {
                await this.startSpeakersObservation(functionsExist.speakersObserverExists)
                console.log('RECORDING disabled - skipping video recording setup')
                this.context.startTime = Date.now()
                Events.inCallRecording({ start_time: this.context.startTime })
                return
            }

        } catch (error) {
            console.error('Error in setupBrowserComponents:', error)
            // Log additional context to help diagnose the issue
            console.error('Context state:', {
                hasBackgroundPage: !!this.context.backgroundPage,
                recordingMode: this.context.params.recording_mode,
                meetingProvider: this.context.params.meetingProvider,
                botName: this.context.params.bot_name,
            })

            // Re-throw the error, but with more context
            throw new Error(`Browser component setup failed: ${error as Error}`)
        }

        // Mode RECORDING=true : Démarrer l'enregistrement d'abord
        // Check if startRecording exists
        const recordingFunctionsExist =
            await this.context.backgroundPage.evaluate(() => {
                const w = window as any
                return {
                    startRecordingExists:
                        typeof w.startRecording === 'function',
                    initMediaRecorderExists:
                        typeof w.initMediaRecorder === 'function',
                    recordModuleExists: typeof w.record !== 'undefined',
                }
            })

        console.log('Recording functions status:', recordingFunctionsExist)

        // Start recording with improved error handling
        let startTime: number
        let recordingStartedSuccessfully = false
        
        try {
            if (recordingFunctionsExist.startRecordingExists) {
                console.log('Calling startRecording with parameters:', {
                    local_recording_server_location:
                        this.context.params.local_recording_server_location,
                    chunk_duration: MEETING_CONSTANTS.CHUNK_DURATION,
                    streaming_output: this.context.params.streaming_output,
                    streaming_audio_frequency:
                        this.context.params.streaming_audio_frequency,
                })

                startTime = await this.context.backgroundPage.evaluate(
                    async (params) => {
                        const w = window as any
                        try {
                            // Loguer pour voir si la fonction est appelée
                            console.log(
                                'Calling window.startRecording function...',
                            )

                            const result = await w.startRecording(
                                params.local_recording_server_location,
                                params.chunk_duration,
                                params.streaming_output,
                                params.streaming_audio_frequency,
                            )

                            console.log('startRecording returned:', result)
                            return result || Date.now() // Fallback si undefined
                        } catch (error) {
                            console.error('Error in startRecording:', error)
                            throw error // Re-throw pour indiquer l'échec
                        }
                    },
                    {
                        local_recording_server_location:
                            this.context.params.local_recording_server_location,
                        chunk_duration: MEETING_CONSTANTS.CHUNK_DURATION,
                        streaming_output: this.context.params.streaming_output,
                        streaming_audio_frequency:
                            this.context.params.streaming_audio_frequency,
                    },
                )
                recordingStartedSuccessfully = true
            } else {
                console.warn(
                    'startRecording function not found in extension context',
                )
                startTime = Date.now()
                recordingStartedSuccessfully = false // Pas de fonction d'enregistrement
            }
        } catch (error) {
            console.error('Error starting recording:', error)
            startTime = Date.now()
            recordingStartedSuccessfully = false
        }

        // Set start time in context
        this.context.startTime = startTime || Date.now()
        console.log(`Recording started at timestamp: ${this.context.startTime}`)

        // Démarrer l'observation des speakers seulement si l'enregistrement a réussi (ou si pas de fonction d'enregistrement)
        if (recordingStartedSuccessfully || !recordingFunctionsExist.startRecordingExists) {
            const functionsExist = await this.context.backgroundPage.evaluate(
                () => {
                    const w = window as any
                    return {
                        speakersObserverExists:
                            typeof w.start_speakers_observer === 'function',
                    }
                },
            )
            
            await this.startSpeakersObservation(functionsExist.speakersObserverExists)
        } else {
            console.error('Recording failed to start - skipping speakers observation to avoid inconsistent data')
        }

        // Notifier que l'enregistrement est démarré
        Events.inCallRecording({ start_time: this.context.startTime })
    }

    private async startSpeakersObservation(speakersObserverExists: boolean): Promise<void> {
        // Démarrer SpeakerManager
        SpeakerManager.start()

        if (speakersObserverExists) {
            // Start speaker observation
            await this.context.backgroundPage.evaluate(
                async (params) => {
                    const w = window as any
                    await w.start_speakers_observer(
                        params.recording_mode,
                        params.bot_name,
                        params.meetingProvider,
                        params.local_recording_server_location, // Passer l'URL pour initialiser ApiService
                    )
                },
                {
                    recording_mode: this.context.params.recording_mode,
                    bot_name: this.context.params.bot_name,
                    meetingProvider: this.context.params.meetingProvider,
                    local_recording_server_location: this.context.params.local_recording_server_location,
                },
            )
            console.log('Speakers observer started successfully')
        } else {
            console.warn(
                'start_speakers_observer function not found in extension context',
            )
            // Continue without speakers observer - this is non-critical
        }
    }
}
