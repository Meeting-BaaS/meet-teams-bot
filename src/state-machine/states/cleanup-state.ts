import { SoundContext, VideoContext } from '../../media_context'
import { ScreenRecorderManager } from '../../recording/ScreenRecorder'
import { HtmlSnapshotService } from '../../services/html-snapshot-service'
import { MEETING_CONSTANTS } from '../constants'
import { MeetingStateType, StateExecuteResult } from '../types'
import { BaseState } from './base-state'
import { formatError } from '../../utils/Logger'
import { SoundLevelMonitor } from '../../utils/sound-level-monitor'

export class CleanupState extends BaseState {
    async execute(): StateExecuteResult {
        try {
            console.info('🧹 Starting cleanup sequence')

            // Use Promise.race to implement the timeout
            const cleanupPromise = this.performCleanup()
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(
                    () => reject(new Error('Cleanup timeout')),
                    MEETING_CONSTANTS.CLEANUP_TIMEOUT,
                )
            })

            try {
                console.info('🧹 Running cleanup with timeout protection')
                await Promise.race([cleanupPromise, timeoutPromise])
                console.info('🧹 Cleanup completed successfully')
            } catch (error) {
                console.error('🧹 Cleanup failed or timed out:', formatError(error))
                // Continue to Terminated even if cleanup fails
            }
            console.info('🧹 Transitioning to Terminated state')
            return this.transition(MeetingStateType.Terminated)
        } catch (error) {
            console.error('🧹 Error during cleanup:', formatError(error))
            // Always transition to Terminated to avoid infinite loops
            console.info('🧹 Forcing transition to Terminated despite error')
            return this.transition(MeetingStateType.Terminated)
        }
    }

    private async performCleanup(): Promise<void> {
        try {
            // Step 1: Capture final DOM state while page is still alive
            if (this.context.playwrightPage) {
                console.info('🧹 Step 1/5: Capturing final DOM state')
                const htmlSnapshot = HtmlSnapshotService.getInstance()
                await htmlSnapshot.captureSnapshot(
                    this.context.playwrightPage,
                    'cleanup_final_dom_state',
                )
            }

            // Step 2: Close meeting page — bot leaves the meeting instantly.
            // All injected JS (dialog observer, HTML cleaner, speakers observer)
            // dies with the page. FFmpeg keeps recording the now-blank Xvfb display.
            console.info('🧹 Step 2/5: Closing meeting page (bot leaves meeting)')
            try {
                await this.context.playwrightPage?.close().catch(() => {})
                this.context.playwrightPage = null
            } catch (error) {
                console.warn('🧹 Failed to close meeting page:', formatError(error))
                this.context.playwrightPage = null
            }

            // Step 3: Stop services that run in Node (not in the browser)
            console.info('🧹 Step 3/5: Stopping Node services (streaming + sound monitor)')
            await Promise.allSettled([
                (async () => {
                    if (this.context.streamingService) {
                        await this.context.streamingService.stop()
                    }
                })(),
                (async () => {
                    SoundLevelMonitor.stopIfStarted()
                })(),
            ])

            // Step 4: Stop ScreenRecorder (SIGINT FFmpeg → grace period → file processing)
            console.info('🧹 Step 4/5: Stopping ScreenRecorder')
            await this.stopScreenRecorder()

            // Step 5: Close browser context and remaining resources
            console.info('🧹 Step 5/5: Cleaning up browser resources')
            await this.cleanupBrowserResources()

            console.info('🧹 All cleanup steps completed')
        } catch (error) {
            console.error('🧹 Cleanup error:', formatError(error))
            // Continue even if an error occurs
            return
        }
    }

    private async stopScreenRecorder(): Promise<void> {
        try {
            if (ScreenRecorderManager.getInstance().isCurrentlyRecording()) {
                console.log('Stopping ScreenRecorder from cleanup state...')
                await ScreenRecorderManager.getInstance().stopRecording()
                console.log('ScreenRecorder stopped successfully')
            } else {
                console.log('ScreenRecorder not recording, nothing to stop')
            }
        } catch (error) {
            console.error('Error stopping ScreenRecorder:', formatError(error))

            // Don't throw error if recording was already stopped
            if (
                error instanceof Error &&
                error.message &&
                error.message.includes('not recording')
            ) {
                console.log(
                    'ScreenRecorder was already stopped, continuing cleanup',
                )
            } else {
                throw error
            }
        }
    }

    private async cleanupBrowserResources(): Promise<void> {
        try {
            // 1. Stop branding
            if (this.context.brandingProcess) {
                this.context.brandingProcess.kill()
            }

            // 2. Stop media contexts
            VideoContext.instance?.stop()
            SoundContext.instance?.stop()

            // 3. Close browser context (page already closed in step 2)
            await this.context.browserContext?.close().catch(() => {})
        } catch (error) {
            console.error('Failed to cleanup browser resources:', formatError(error))
        }
    }
}
