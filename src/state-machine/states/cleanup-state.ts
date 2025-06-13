import { delSessionInRedis } from '../../instance'
import { SoundContext, VideoContext } from '../../media_context'
import { SCREEN_RECORDER } from '../../recording/ScreenRecorder'
import { MEETING_CONSTANTS } from '../constants'

import { MeetingStateType, StateExecuteResult } from '../types'
import { BaseState } from './base-state'

export class CleanupState extends BaseState {
    async execute(): StateExecuteResult {
        try {
            console.info('Starting cleanup sequence')

            // Use Promise.race to implement the timeout
            const cleanupPromise = this.performCleanup()
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(
                    () => reject(new Error('Cleanup timeout')),
                    MEETING_CONSTANTS.CLEANUP_TIMEOUT,
                )
            })

            try {
                await Promise.race([cleanupPromise, timeoutPromise])
            } catch (error) {
                console.error('Cleanup failed or timed out:', error)
            }
            return this.transition(MeetingStateType.Terminated) // État final
        } catch (error) {
            console.error('Error during cleanup:', error)
            // Even in case of error, we stay in Cleanup state
            return this.transition(MeetingStateType.Cleanup)
        }
    }

    private async performCleanup(): Promise<void> {
        try {
            // 1. Arrêter le ScreenRecorder
            await this.stopScreenRecorder()

            // 2.Arrêter le streaming
            if (this.context.streamingService) {
                this.context.streamingService.stop()
            }

            // 3. Clean up extension resources and browser
            await this.cleanupBrowserResources()

            // 4. Upload the video to S3 (handled automatically by ScreenRecorder now)
            console.log('Video upload handled automatically by ScreenRecorder')

            // 5. Final Redis cleanup
            await this.cleanupRedisSession()
        } catch (error) {
            console.error('Cleanup error:', error)
            // Continue even if an error occurs
        }
    }

    private async stopScreenRecorder(): Promise<void> {
        try {
            if (SCREEN_RECORDER.isCurrentlyRecording()) {
                console.log('Stopping ScreenRecorder from cleanup state...')
                await SCREEN_RECORDER.stopRecording()
                console.log('ScreenRecorder stopped successfully')
            } else {
                console.log('ScreenRecorder not recording, nothing to stop')
            }
        } catch (error) {
            console.error('Error stopping ScreenRecorder:', error)
            throw error
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

            // 3. Close pages and clean the browser
            await Promise.all([
                this.context.playwrightPage?.close().catch(() => {}),
                this.context.backgroundPage?.close().catch(() => {}),
                this.context.browserContext?.close().catch(() => {}),
            ])

            // 4. Clear timeouts
            if (this.context.meetingTimeoutInterval) {
                clearTimeout(this.context.meetingTimeoutInterval)
            }
        } catch (error) {
            console.error('Failed to cleanup browser resources:', error)
        }
    }

    private async uploadVideoToS3(): Promise<void> {
        try {
            // ScreenRecorder handles S3 upload automatically during stopRecording()
            // Only upload manually if not already done
            if (!SCREEN_RECORDER.getFilesUploaded()) {
                console.log('Uploading video to S3 via ScreenRecorder')
                await SCREEN_RECORDER.uploadToS3()
            } else {
                console.log(
                    'Files already uploaded to S3 by ScreenRecorder, skipping',
                )
            }
        } catch (error) {
            console.error('Failed to upload video to S3:', error)
        }
    }

    private async cleanupRedisSession(): Promise<void> {
        if (!this.context.params.session_id) return

        try {
            await delSessionInRedis(this.context.params.session_id)
        } catch (error) {
            console.error('Failed to cleanup Redis session:', error)
        }
    }
}
