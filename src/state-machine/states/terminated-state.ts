import { CAPTCHAHandler } from '../../utils/CAPTCHAHandler'
import { MeetingStateType, StateExecuteResult } from '../types'
import { BaseState } from './base-state'

export class TerminatedState extends BaseState {
    async execute(): StateExecuteResult {
        console.info('Meeting state machine terminated')

        // Ensure CAPTCHA handler is in cleanup mode
        CAPTCHAHandler.setCleanupMode(true)
        console.info(
            '🧹 CAPTCHA handler cleanup mode confirmed in terminated state',
        )

        // This state is terminal and does not transition to another state
        // Return the same state to indicate termination
        return { nextState: MeetingStateType.Terminated, context: this.context }
    }
}
