import { openBrowser } from '../../browser/browser'
import { Events } from '../../events'
import { ScreenRecorderManager } from '../../recording/ScreenRecorder'
import { GLOBAL } from '../../singleton'
import { JoinError, JoinErrorCode } from '../../types'
import { takeScreenshot } from '../../utils/takeScreenshot'
import {
    MeetingStateType,
    RecordingEndReason,
    StateExecuteResult,
} from '../types'
import { BaseState } from './base-state'

export class WaitingRoomState extends BaseState {
    async execute(): StateExecuteResult {
        try {
            console.info('Entering waiting room state')
            Events.inWaitingRoom()

            // Get meeting information
            const { meetingId, password } = await this.getMeetingInfo()
            console.info('Meeting info retrieved', {
                meetingId,
                hasPassword: !!password,
            })

            // Generate the meeting link
            const meetingLink = this.context.provider.getMeetingLink(
                meetingId,
                password,
                0,
                GLOBAL.get().bot_name,
                GLOBAL.get().enter_message,
            )

            // Open the meeting page
            await this.openMeetingPage(meetingLink)

            // Wait for acceptance into the meeting
            await this.waitForAcceptance()
            console.info('Successfully joined meeting')

            // If everything is fine, move to the InCall state
            return this.transition(MeetingStateType.InCall)
        } catch (error) {
            // Arrêter l'observateur en cas d'erreur
            this.stopDialogObserver()

            console.error('Error in waiting room state:', error)

            if (error instanceof JoinError) {
                switch (error.message) {
                    case JoinErrorCode.BotNotAccepted:
                        Events.botRejected()
                        return this.handleError(error)
                    case JoinErrorCode.TimeoutWaitingToStart:
                        Events.waitingRoomTimeout()
                        return this.handleError(error)
                }
            }

            return this.handleError(error as Error)
        }
    }

    private async getMeetingInfo() {
        // No need to check browserContext anymore since we create it in openMeetingPage
        try {
            return await this.context.provider.parseMeetingUrl(
                GLOBAL.get().meeting_url,
            )
        } catch (error) {
            console.error('Failed to parse meeting URL:', error)
            throw new JoinError(JoinErrorCode.InvalidMeetingUrl)
        }
    }

    private async openMeetingPage(meetingLink: string) {
        try {
            console.info('Attempting to open meeting page:', meetingLink)
            
            // Create the meeting context with video recording
            const { browser: meetingContext } = await openBrowser(false)
            
            // Create the meeting page using the provider
            this.context.playwrightPage =
                await this.context.provider.openMeetingPage(
                    meetingContext,
                    meetingLink,
                    GLOBAL.get().streaming_input,
                )
            console.info('Meeting page opened successfully')

            // Start the dialog observer now that the page is open
            this.startDialogObserver()

            // Configure and start audio recording
            console.info('Configuring audio recording...')
            const screenRecorder = ScreenRecorderManager.getInstance()

            // Configure the recorder with PathManager and recording mode
            screenRecorder.configure(
                this.context.pathManager!,
            )

            // Set the page for sync calibration
            screenRecorder.setPage(this.context.playwrightPage)

            // Start audio recording
            console.info('Starting audio recording...')
            await screenRecorder.startRecording()
            console.info('Audio recording started successfully')
        } catch (error) {
            console.error('Failed to open meeting page:', {
                error,
                message:
                    error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
            })

            // Take screenshot if possible
            if (this.context.playwrightPage) {
                try {
                    await takeScreenshot(
                        this.context.playwrightPage,
                        'waiting-room-error',
                    )
                    console.info('Error screenshot saved')
                } catch (screenshotError) {
                    console.error(
                        'Failed to take error screenshot:',
                        screenshotError,
                    )
                }
            }

            throw new Error(
                error instanceof Error
                    ? error.message
                    : 'Failed to open meeting page',
            )
        }
    }

    private async waitForAcceptance(): Promise<void> {
        if (!this.context.playwrightPage) {
            throw new Error('Meeting page not initialized')
        }

        const timeoutMs =
            GLOBAL.get().automatic_leave.waiting_room_timeout * 1000
        console.info(`Setting waiting room timeout to ${timeoutMs}ms`)

        let joinSuccessful = false // Flag indicating we joined the meeting

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!joinSuccessful) {
                    // Trigger the timeout only if we are not in the meeting
                    const timeoutError = new JoinError(
                        JoinErrorCode.TimeoutWaitingToStart,
                    )
                    console.error('Waiting room timeout reached', timeoutError)
                    reject(timeoutError)
                }
            }, timeoutMs)

            const checkStopSignal = setInterval(() => {
                if (this.context.endReason === RecordingEndReason.ApiRequest) {
                    clearInterval(checkStopSignal)
                    clearTimeout(timeout)
                    reject(new JoinError(JoinErrorCode.ApiRequest))
                }
            }, 1000)

            this.context.provider
                .joinMeeting(
                    this.context.playwrightPage,
                    () =>
                        this.context.endReason ===
                        RecordingEndReason.ApiRequest,
                    // Add a callback to notify that the join succeeded
                    () => {
                        joinSuccessful = true
                        console.log('Join successful notification received')
                    },
                )
                .then(() => {
                    clearInterval(checkStopSignal)
                    clearTimeout(timeout)
                    resolve()
                })
                .catch((error) => {
                    clearInterval(checkStopSignal)
                    clearTimeout(timeout)
                    reject(error)
                })
        })
    }
}
