import {
    MeetingStateType,
    ParticipantState,
    RecordingEndReason,
    StateTransition,
} from './types'

import { GLOBAL } from '../singleton'
import { CAPTCHAHandler } from '../utils/CAPTCHAHandler'
import { getStateInstance } from './states'
import { MeetingContext } from './types'

export class MeetingStateMachine {
    private currentState: MeetingStateType
    public context: MeetingContext
    private error: Error | null = null
    private forceStop: boolean = false
    private wasInRecordingState: boolean = false
    private normalTermination: boolean = false
    private captchaHandler: CAPTCHAHandler

    constructor(initialContext: Partial<MeetingContext>) {
        this.currentState = MeetingStateType.Initialization
        this.context = {
            ...initialContext,
            error: null,
        } as MeetingContext

        // Initialize CAPTCHA handler
        this.captchaHandler = new CAPTCHAHandler({
            enabled: true,
            maxAttempts: 2, // Lower attempts for state machine integration
            timeoutMs: 15000, // Shorter timeout for state machine
            confidenceThreshold: 0.6,
            languages: ['en', 'fr', 'es', 'de'],
            retryDelayMs: 1000,
        })

        // Setup global dialog observer functions
        this.setupGlobalDialogObserver()
    }

    private setupGlobalDialogObserver(): void {
        // Fonction pour gérer l'observateur de dialogues globalement
        this.context.startGlobalDialogObserver = () => {
            // Only start observer for Google Meet
            if (GLOBAL.get().meetingProvider !== 'Meet') {
                console.info(
                    `Global dialog observer not started: provider is not Google Meet (${GLOBAL.get().meetingProvider})`,
                )
                return
            }

            if (!this.context.playwrightPage) {
                console.warn(
                    'Cannot start global dialog observer: page not available',
                )
                return
            }

            // Nettoyer tout observateur existant
            if (this.context.dialogObserverInterval) {
                clearInterval(this.context.dialogObserverInterval)
            }

            // Create a new observer with verification interval
            console.info(`Starting global dialog observer in state machine`)

            // Function to check and restart observer if necessary
            const checkAndRestartObserver = () => {
                if (!this.context.dialogObserverInterval) {
                    console.warn(
                        'Global dialog observer was stopped, restarting...',
                    )
                    this.context.startGlobalDialogObserver?.()
                    return
                }
            }

            // Heartbeat to check observer state every 2 seconds
            const heartbeatInterval = setInterval(checkAndRestartObserver, 2000)

            // Stocker l'intervalle de heartbeat pour pouvoir le nettoyer plus tard
            this.context.dialogObserverHeartbeat = heartbeatInterval

            this.context.dialogObserverInterval = setInterval(async () => {
                try {
                    if (this.context.playwrightPage?.isClosed()) {
                        this.context.stopGlobalDialogObserver?.()
                        return
                    }

                    // Check for CAPTCHA challenges first
                    try {
                        const captchaResult =
                            await this.captchaHandler.handleCAPTCHA(
                                this.context.playwrightPage!,
                            )

                        if (captchaResult.success && captchaResult.solution) {
                            console.info(
                                `[GlobalDialogObserver] CAPTCHA solved successfully: "${captchaResult.solution}" in state ${this.currentState}`,
                            )
                        } else if (
                            !captchaResult.success &&
                            captchaResult.error
                        ) {
                            console.warn(
                                `[GlobalDialogObserver] CAPTCHA handling failed: ${captchaResult.error} in state ${this.currentState}`,
                            )
                        }
                    } catch (captchaError) {
                        console.warn(
                            `[GlobalDialogObserver] CAPTCHA detection error: ${captchaError}`,
                        )
                    }

                    // Chercher le dialogue "Got it"
                    const gotItDialog = this.context.playwrightPage.locator(
                        [
                            '[role="dialog"][aria-modal="true"][aria-label="Others may see your video differently"]',
                            '[role="dialog"]:has(button:has-text("Got it"))',
                            '[aria-modal="true"]:has(button:has-text("Got it"))',
                        ].join(','),
                    )

                    const isVisible = await gotItDialog
                        .isVisible({ timeout: 300 })
                        .catch(() => false)

                    if (isVisible) {
                        console.info(
                            `[GlobalDialogObserver] Found "Got it" dialog in state ${this.currentState}`,
                        )

                        // Trouver le bouton Got it
                        const gotItButton = gotItDialog.locator(
                            'button:has-text("Got it")',
                        )
                        await gotItButton
                            .click({ force: true, timeout: 1000 })
                            .catch(async (err) => {
                                console.warn(
                                    `[GlobalDialogObserver] Failed to click with regular method: ${err.message}`,
                                )

                                // Fallback: essayer de cliquer avec JavaScript directement
                                await this.context.playwrightPage
                                    ?.evaluate(() => {
                                        const buttons =
                                            document.querySelectorAll('button')
                                        for (const button of buttons) {
                                            if (
                                                button.textContent?.includes(
                                                    'Got it',
                                                )
                                            ) {
                                                ;(button as HTMLElement).click()
                                                return true
                                            }
                                        }
                                        return false
                                    })
                                    .catch((e) =>
                                        console.error(
                                            `[GlobalDialogObserver] JavaScript click failed: ${e.message}`,
                                        ),
                                    )
                            })

                        console.info(
                            `[GlobalDialogObserver] Clicked "Got it" button`,
                        )
                    }
                } catch (error) {
                    console.error(
                        `[GlobalDialogObserver] Error checking for dialogs: ${error}`,
                    )
                    // En cas d'erreur, on redémarre l'observateur
                    this.context.stopGlobalDialogObserver?.()
                    this.context.startGlobalDialogObserver?.()
                }
            }, 2000) // Check every 2 seconds
        }

        // Fonction pour arrêter l'observateur
        this.context.stopGlobalDialogObserver = () => {
            if (this.context.dialogObserverInterval) {
                clearInterval(this.context.dialogObserverInterval)
                this.context.dialogObserverInterval = undefined
                console.info(`Stopped global dialog observer`)
            }
            if (this.context.dialogObserverHeartbeat) {
                clearInterval(this.context.dialogObserverHeartbeat)
                this.context.dialogObserverHeartbeat = undefined
                console.info(`Stopped global dialog observer heartbeat`)
            }
        }
    }

    public async start(): Promise<void> {
        try {
            // Démarrer l'observateur global dès le début
            this.context.startGlobalDialogObserver?.()

            while (
                this.currentState !== MeetingStateType.Terminated &&
                !this.forceStop
            ) {
                console.info(`Current state: ${this.currentState}`)

                if (this.currentState === MeetingStateType.Recording) {
                    this.wasInRecordingState = true
                }

                if (this.forceStop) {
                    this.context.endReason =
                        this.context.endReason || RecordingEndReason.ApiRequest
                    await this.transitionToCleanup()
                    break
                }

                const state = getStateInstance(this.currentState, this.context)
                const transition: StateTransition = await state.execute()

                this.currentState = transition.nextState
                this.context = transition.context
            }

            // Arrêter l'observateur global à la fin
            this.context.stopGlobalDialogObserver?.()

            if (this.wasInRecordingState && this.context.endReason) {
                const normalReasons = [
                    RecordingEndReason.ApiRequest,
                    RecordingEndReason.BotRemoved,
                    RecordingEndReason.ManualStop,
                    RecordingEndReason.NoAttendees,
                    RecordingEndReason.NoSpeaker,
                    RecordingEndReason.RecordingTimeout,
                ]
                this.normalTermination = normalReasons.includes(
                    this.context.endReason,
                )
            }
        } catch (error) {
            // Arrêter l'observateur global en cas d'erreur
            this.context.stopGlobalDialogObserver?.()

            this.error = error as Error
            await this.handleError(error as Error)
        }
    }

    public async requestStop(reason: RecordingEndReason): Promise<void> {
        console.info(`Stop requested with reason: ${reason}`)
        this.forceStop = true
        this.context.endReason = reason
    }

    public getCurrentState(): MeetingStateType {
        return this.currentState
    }

    public getError(): Error | null {
        return this.error
    }

    public getStartTime(): number {
        return this.context.startTime!
    }

    private async handleError(error: Error): Promise<void> {
        try {
            console.error('Error in state machine:', error)
            this.error = error
            this.context.error = error

            // Passer à l'état d'erreur
            const errorState = getStateInstance(
                MeetingStateType.Error,
                this.context,
            )
            await errorState.execute()
        } catch (secondaryError) {
            console.error('Error handling error:', secondaryError)
        } finally {
            // Dans tous les cas, on termine par le nettoyage
            await this.transitionToCleanup()
        }
    }

    public async pauseRecording(): Promise<void> {
        if (this.currentState !== MeetingStateType.Recording) {
            throw new Error('Cannot pause: meeting is not in recording state')
        }

        console.info('Pause requested')
        this.context.isPaused = true
        this.currentState = MeetingStateType.Paused
    }

    public async resumeRecording(): Promise<void> {
        if (this.currentState !== MeetingStateType.Paused) {
            throw new Error('Cannot resume: meeting is not paused')
        }

        console.info('Resume requested')
        this.context.isPaused = false
        this.currentState = MeetingStateType.Resuming
    }

    public isPaused(): boolean {
        return this.currentState === MeetingStateType.Paused
    }

    public getPauseDuration(): number {
        return this.context.totalPauseDuration || 0
    }

    public updateParticipantState(state: ParticipantState): void {
        if (this.currentState === MeetingStateType.Recording) {
            this.context.attendeesCount = state.attendeesCount
            if (state.firstUserJoined) {
                this.context.firstUserJoined = true
            }
            this.context.lastSpeakerTime = state.lastSpeakerTime
            this.context.noSpeakerDetectedTime = state.noSpeakerDetectedTime

            console.info('Updated participant state:', {
                attendeesCount: state.attendeesCount,
                firstUserJoined: this.context.firstUserJoined,
                lastSpeakerTime: state.lastSpeakerTime,
                noSpeakerDetectedTime: state.noSpeakerDetectedTime,
                state: this.currentState,
            })
        }
    }

    private async transitionToCleanup(): Promise<void> {
        this.currentState = MeetingStateType.Cleanup
        const cleanupState = getStateInstance(
            MeetingStateType.Cleanup,
            this.context,
        )
        await cleanupState.execute()
    }

    public getContext(): MeetingContext {
        return this.context
    }

    public wasRecordingSuccessful(): boolean {
        return this.wasInRecordingState && this.normalTermination && !this.error
    }

    public getWasInRecordingState(): boolean {
        return this.wasInRecordingState
    }

    public getNormalTermination(): boolean {
        return this.normalTermination
    }
}
