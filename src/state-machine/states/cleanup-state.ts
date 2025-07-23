import { SoundContext, VideoContext } from '../../media_context'
import { ScreenRecorderManager } from '../../recording/ScreenRecorder'
import { MEETING_CONSTANTS } from '../constants'

import { MeetingStateType, StateExecuteResult } from '../types'
import { BaseState } from './base-state'

export class CleanupState extends BaseState {
    async execute(): StateExecuteResult {
        try {
            console.info('🧹 Starting cleanup sequence')

            // Disable CAPTCHA detection during cleanup
            const { CAPTCHAHandler } = await import(
                '../../utils/CAPTCHAHandler'
            )
            CAPTCHAHandler.setCleanupMode(true)

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
                console.error('🧹 Cleanup failed or timed out:', error)
                // Continue to Terminated even if cleanup fails
            }
            console.info('🧹 Transitioning to Terminated state')
            return this.transition(MeetingStateType.Terminated) // État final
        } catch (error) {
            console.error('🧹 Error during cleanup:', error)
            // Always transition to Terminated to avoid infinite loops
            console.info('🧹 Forcing transition to Terminated despite error')
            return this.transition(MeetingStateType.Terminated)
        }
    }

    private async performCleanup(): Promise<void> {
        try {
            // 🎬 PRIORITY 1: Stop video recording immediately to avoid data loss
            console.info('🧹 Step 1/5: Stopping ScreenRecorder (PRIORITY)')
            await this.stopScreenRecorder()

            // 🚀 PARALLEL CLEANUP: Independent steps that can run simultaneously
            console.info(
                '🧹 Steps 2-4: Running parallel cleanup (streaming + speakers + HTML)',
            )
            await Promise.allSettled([
                (async () => {
                    console.info('🧹 Step 1.5/5: Stopping dialog observer')
                    this.stopDialogObserver()
                })(),
                // 2. Stop the streaming (fast, no await needed)
                (async () => {
                    console.info('🧹 Step 2/5: Stopping streaming service')
                    if (this.context.streamingService) {
                        this.context.streamingService.stop()
                    }
                })(),

                // 3. Stop speakers observer (with 3s timeout)
                (async () => {
                    console.info('🧹 Step 3/5: Stopping speakers observer')
                    await this.stopSpeakersObserver()
                })(),

                // 4. Stop HTML cleaner (with 3s timeout)
                (async () => {
                    console.info('🧹 Step 4/5: Stopping HTML cleaner')
                    await this.stopHtmlCleaner()
                })(),

                // 5. Clean up CAPTCHA resources (with 3s timeout)
                (async () => {
                    console.info('🧹 Step 4.5/5: Cleaning up CAPTCHA resources')
                    await this.cleanupCAPTCHAResources()
                })(),
            ])

            console.info('🧹 Parallel cleanup completed')

            console.info('🧹 Step 5/5: Cleaning up browser resources')
            // 5. Clean up browser resources (must be sequential after others)
            await this.cleanupBrowserResources()

            console.info('🧹 All cleanup steps completed')
        } catch (error) {
            console.error('🧹 Cleanup error:', error)
            // Continue even if an error occurs
        }
    }

    private async stopSpeakersObserver(): Promise<void> {
        try {
            if (this.context.speakersObserver) {
                console.log('Stopping speakers observer from cleanup state...')

                // Add 3-second timeout to prevent hanging
                await Promise.race([
                    (async () => {
                        this.context.speakersObserver.stopObserving()
                        this.context.speakersObserver = null
                    })(),
                    new Promise((_, reject) =>
                        setTimeout(
                            () =>
                                reject(
                                    new Error('Speakers observer stop timeout'),
                                ),
                            3000,
                        ),
                    ),
                ])

                console.log('Speakers observer stopped successfully')
            } else {
                console.log('Speakers observer not active, nothing to stop')
            }
        } catch (error) {
            if (error instanceof Error && error.message?.includes('timeout')) {
                console.warn(
                    'Speakers observer stop timed out after 3s, continuing cleanup',
                )
                // Force cleanup
                this.context.speakersObserver = null
            } else {
                console.error('Error stopping speakers observer:', error)
            }
            // Don't throw as this is non-critical
        }
    }

    private async stopHtmlCleaner(): Promise<void> {
        try {
            if (this.context.htmlCleaner) {
                console.log('Stopping HTML cleaner from cleanup state...')

                // Add 3-second timeout to prevent hanging
                await Promise.race([
                    this.context.htmlCleaner.stop(),
                    new Promise((_, reject) =>
                        setTimeout(
                            () =>
                                reject(new Error('HTML cleaner stop timeout')),
                            3000,
                        ),
                    ),
                ])

                this.context.htmlCleaner = undefined
                console.log('HTML cleaner stopped successfully')
            } else {
                console.log('HTML cleaner not active, nothing to stop')
            }
        } catch (error) {
            if (error instanceof Error && error.message?.includes('timeout')) {
                console.warn(
                    'HTML cleaner stop timed out after 3s, continuing cleanup',
                )
                // Force cleanup
                this.context.htmlCleaner = undefined
            } else {
                console.error('Error stopping HTML cleaner:', error)
            }
            // Don't throw as this is non-critical
        }
    }

    private async stopScreenRecorder(): Promise<void> {
        try {
            const recorder = ScreenRecorderManager.getInstance()
            if (recorder.isCurrentlyRecording()) {
                console.log('🎬 Stopping ScreenRecorder from cleanup state...')
                await recorder.stopRecording()
                console.log('✅ ScreenRecorder stopped successfully')
            } else {
                // Check if FFmpeg process is running but not recording (screenshots only)
                console.log(
                    '📸 ScreenRecorder not in recording mode - may have screenshots only',
                )
            }
        } catch (error) {
            console.error('❌ Error stopping ScreenRecorder:', error)
            // Don't throw error if recording was already stopped
            if (
                error instanceof Error &&
                error.message &&
                error.message.includes('not recording')
            ) {
                console.log(
                    'ℹ️ ScreenRecorder was already stopped, continuing cleanup',
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

            // 3. Close pages and clean the browser
            await Promise.all([
                this.context.playwrightPage?.close().catch(() => {}),
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

    private async cleanupCAPTCHAResources(): Promise<void> {
        try {
            // Clean up any active CAPTCHA handlers
            if (this.context.provider) {
                // Access the CAPTCHA handler if it exists
                const provider = this.context.provider as any
                if (provider.captchaHandler) {
                    console.log('🧹 Cleaning up CAPTCHA handler...')
                    // Note: CAPTCHA handlers are stateless, so just log for now
                    console.log('🧹 CAPTCHA handler cleanup completed')
                }
            }

            // Note: Tesseract workers are terminated immediately after use
            // Temp files are preserved for debugging
            console.log('🧹 CAPTCHA resources cleanup completed')
        } catch (error) {
            console.error('🧹 Error cleaning up CAPTCHA resources:', error)
        }
    }
}
