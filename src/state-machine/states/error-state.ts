import { Events } from '../../events'
import { GLOBAL } from '../../singleton'
import { HtmlSnapshotService } from '../../services/html-snapshot-service'

import {
    MeetingEndReason,
    MeetingStateType,
    StateExecuteResult,
} from '../types'
import { BaseState } from './base-state'

export class ErrorState extends BaseState {
    async execute(): StateExecuteResult {
        try {
            // Log the error
            await this.logError()

            // Notify error events
            await this.notifyError()

            // Update metrics
            this.updateMetrics()

            // Move to cleanup
            return this.transition(MeetingStateType.Cleanup)
        } catch (error) {
            console.error('Error in ErrorState:', error)
            // Even if error handling fails, transition to cleanup
            return this.transition(MeetingStateType.Cleanup)
        }
    }

    private async logError(): Promise<void> {
        const errorMessage = GLOBAL.getErrorMessage()
        const endReason = GLOBAL.getEndReason()

        // Capture DOM state on error if page is available (void to avoid blocking)
        if (this.context.playwrightPage) {
            const htmlSnapshot = HtmlSnapshotService.getInstance()
            void htmlSnapshot.captureSnapshot(
                this.context.playwrightPage,
                'error_state_dom_capture',
            )
        }

        if (!endReason) {
            console.error('Unknown error occurred')
            return
        }

        // Create a detailed error object
        const errorDetails = {
            message: errorMessage || 'Unknown error',
            reason: endReason,
            state: this.stateType,
            meetingUrl: GLOBAL.get().meeting_url,
            botName: GLOBAL.get().bot_name,
            sessionId: GLOBAL.get().session_id,
            timestamp: Date.now(),
        }

        // Log the error with all details
        console.error('Meeting error occurred:', errorDetails)
    }

    private async notifyError(): Promise<void> {
        const notifyPromise = async (): Promise<void> => {
            const endReason = GLOBAL.getEndReason()
            const errorMessage = GLOBAL.getErrorMessage()

            if (!endReason) {
                console.warn('No error reason found in global singleton')
                return
            }

            // Full log for debugging
            console.log('Error in notifyError:', {
                reason: endReason,
                message: errorMessage,
            })

            try {
                switch (endReason) {
                    case MeetingEndReason.BotNotAccepted:
                        await Events.botRejected()
                        break
                    case MeetingEndReason.BotRemoved:
                        await Events.botRemoved()
                        break
                    case MeetingEndReason.BotRemovedTooEarly:
                        await Events.botRemovedTooEarly()
                        break
                    case MeetingEndReason.TimeoutWaitingToStart:
                        await Events.waitingRoomTimeout()
                        break
                    case MeetingEndReason.InvalidMeetingUrl:
                        await Events.invalidMeetingUrl()
                        break
                    case MeetingEndReason.ApiRequest:
                        console.log('Notifying API request stop')
                        await Events.apiRequestStop()
                        break
                    default:
                        console.log(`Unhandled error reason: ${endReason}`)
                        await Events.meetingError(
                            new Error(errorMessage || 'Unknown error'),
                        )
                }
            } catch (eventError) {
                console.error('Failed to send event notification:', eventError)
            }
        }

        // Increase timeout for error notification
        const timeoutPromise = new Promise<void>(
            (_, reject) =>
                setTimeout(
                    () => reject(new Error('Notify error timeout')),
                    15000,
                ), // 15 seconds instead of 5
        )

        try {
            await Promise.race([notifyPromise(), timeoutPromise])
        } catch (error) {
            console.error('Error notification timed out:', error)
            // Continue even if notification fails
        }
    }

    private updateMetrics(): void {
        const endReason = GLOBAL.getEndReason()
        const errorMessage = GLOBAL.getErrorMessage()

        const metrics = {
            errorType: 'MeetingError',
            errorReason: endReason || 'Internal',
            errorMessage: errorMessage || 'Unknown error',
            timestamp: Date.now(),
            meetingDuration: this.context.startTime
                ? Date.now() - this.context.startTime
                : 0,
            state: this.stateType,
            // Other relevant context metrics
            attendeesCount: this.context.attendeesCount,
            firstUserJoined: this.context.firstUserJoined,
            sessionId: GLOBAL.get().session_id,
        }

        // Log metrics
        console.info('Error metrics:', metrics)
    }
}
