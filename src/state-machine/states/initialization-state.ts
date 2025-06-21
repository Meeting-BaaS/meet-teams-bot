import { generateBranding, playBranding } from '../../branding'
import { MeetingHandle } from '../../meeting'
import { GLOBAL } from '../../singleton'
import { Streaming } from '../../streaming'
import { JoinError, JoinErrorCode } from '../../types'
import { PathManager } from '../../utils/PathManager'
import { MeetingStateType, StateExecuteResult } from '../types'
import { BaseState } from './base-state'

export class InitializationState extends BaseState {
    async execute(): StateExecuteResult {
        try {
            // Validate parameters
            if (!GLOBAL.get().meeting_url) {
                throw new JoinError(JoinErrorCode.InvalidMeetingUrl)
            }

            // Initialize meeting handle if not exists
            if (!this.context.meetingHandle) {
                this.context.meetingHandle = new MeetingHandle()
            }

            // Setup path manager first (important for logs)
            await this.setupPathManager()

            // Setup branding if needed - non-bloquant
            if (GLOBAL.get().custom_branding_bot_path) {
                this.setupBranding().catch((error) => {
                    console.warn(
                        'Branding setup failed, continuing anyway:',
                        error,
                    )
                })
            }

            this.context.streamingService = new Streaming()
              

            // All initialization successful
            return this.transition(MeetingStateType.WaitingRoom)
        } catch (error) {
            return this.handleError(error as Error)
        }
    }

    private async setupBranding(): Promise<void> {
        this.context.brandingProcess = generateBranding(
            GLOBAL.get().bot_name,
            GLOBAL.get().custom_branding_bot_path,
        )
        await this.context.brandingProcess.wait
        playBranding()
    }

    private async setupPathManager(): Promise<void> {
        try {
            if (!this.context.pathManager) {
                this.context.pathManager = PathManager.getInstance()
            }
        } catch (error) {
            console.error('Path manager setup failed:', error)
            // Create base directories if possible
            try {
                const fs = require('fs')
                const path = require('path')
                const baseDir = path.join(
                    process.cwd(),
                    'logs',
                    GLOBAL.get().bot_uuid,
                )
                fs.mkdirSync(baseDir, { recursive: true })
                console.info('Created fallback log directory:', baseDir)
            } catch (fsError) {
                console.error(
                    'Failed to create fallback log directory:',
                    fsError,
                )
            }
            throw error
        }
    }
}
