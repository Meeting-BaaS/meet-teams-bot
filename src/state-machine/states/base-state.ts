import { Page } from '@playwright/test'
import { listenPage } from '../../browser/page-logger'
import { MeetingContext, MeetingStateType, StateExecuteResult } from '../types'
import { formatError } from '../../utils/Logger'

export abstract class BaseState {
    protected context: MeetingContext
    protected stateType: MeetingStateType

    constructor(context: MeetingContext, stateType: MeetingStateType) {
        this.context = context
        this.stateType = stateType

        this.setupPageLoggers()
    }

    private setupPageLoggers(): void {
        if (this.context.playwrightPage) {
            listenPage(this.context.playwrightPage)
            console.info(
                `Setup logger for main page in state ${this.stateType}`,
            )
        }
    }

    protected async setupNewPage(page: Page, pageName: string): Promise<void> {
        listenPage(page)
        console.info(`Setup logger for new page: ${pageName}`)
    }

    abstract execute(): StateExecuteResult

    protected transition(nextState: MeetingStateType): StateExecuteResult {
        return Promise.resolve({
            nextState,
            context: this.context,
        })
    }

    protected async handleError(error: Error): StateExecuteResult {
        console.error(`Error in state ${this.stateType}:`, formatError(error))
        return this.transition(MeetingStateType.Error)
    }
}
