import { Events } from '../../events'
import { ScreenRecorderManager } from '../../recording/ScreenRecorder'
import { GLOBAL } from '../../singleton'
import { Streaming } from '../../streaming'

import {
    MeetingEndReason,
    MeetingStateType,
    StateExecuteResult,
} from '../types'
import { BaseState } from './base-state'

export class WaitingRoomState extends BaseState {
    async execute(): StateExecuteResult {
        try {
            console.info('Entering waiting room state')

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

            // Start the dialog observer before opening the page
            this.startDialogObserver()

            // Open the meeting page
            await this.openMeetingPage(meetingLink)

            this.context.streamingService = new Streaming(
                GLOBAL.get().streaming_input,
                GLOBAL.get().streaming_output,
                GLOBAL.get().streaming_audio_frequency,
                GLOBAL.get().bot_uuid,
            )

            ScreenRecorderManager.getInstance().startRecording(
                this.context.playwrightPage,
            )

            // Send waiting room event after the page is open
            Events.inWaitingRoom()

            // Wait for acceptance into the meeting
            await this.waitForAcceptance()
            console.info('Successfully joined meeting')

            // If everything is fine, move to the InCall state
            return this.transition(MeetingStateType.InCall)
        } catch (error) {
            console.error('Error in waiting room state:', error)

            // Handle specific error types based on MeetingEndReason
            const endReason = GLOBAL.getEndReason()
            if (endReason) {
                switch (endReason) {
                    case MeetingEndReason.BotNotAccepted:
                        Events.botRejected()
                        return this.handleError(error as Error)
                    case MeetingEndReason.TimeoutWaitingToStart:
                        Events.waitingRoomTimeout()
                        return this.handleError(error as Error)
                    case MeetingEndReason.ApiRequest:
                        Events.apiRequestStop()
                        return this.handleError(error as Error)
                }
            }

            return this.handleError(error as Error)
        }
    }

    private async getMeetingInfo() {
        if (!this.context.browserContext) {
            throw new Error('Browser context not initialized')
        }

        try {
            return await this.context.provider.parseMeetingUrl(
                GLOBAL.get().meeting_url,
            )
        } catch (error) {
            console.error('Failed to parse meeting URL:', error)
            GLOBAL.setError(MeetingEndReason.InvalidMeetingUrl)
            throw new Error('Failed to parse meeting URL')
        }
    }

    private async openMeetingPage(meetingLink: string) {
        if (!this.context.browserContext) {
            throw new Error('Browser context not initialized')
        }

        try {
            console.info('Attempting to open meeting page:', meetingLink)
            this.context.playwrightPage =
                await this.context.provider.openMeetingPage(
                    this.context.browserContext,
                    meetingLink,
                    GLOBAL.get().streaming_input,
                )
            console.info('Meeting page opened successfully')

            // Inject virtual camera immediately if enabled - before page loads
            if (
                GLOBAL.get().virtual_camera_enabled &&
                this.context.playwrightPage
            ) {
                try {
                    console.info(
                        'Injecting virtual camera immediately into meeting page...',
                    )

                    // Inject virtual camera script immediately - don't wait for page load
                    await this.context.playwrightPage.evaluate(() => {
                        // Get config from global settings
                        const config = {
                            width: 1280,
                            height: 720,
                            type: 'animated',
                            content: 'Virtual camera with animated background',
                            userImageUrl: 'https://i.ibb.co/N9YtnDZ/ducobu.jpg',
                            showUserImage: true,
                            imagePosition: 'corner',
                            imageOpacity: 0.8,
                        }
                        console.log(
                            '🎥 🎬 ===== WAITING-ROOM VIRTUAL CAMERA INJECTION =====',
                        )
                        console.log(
                            '🎥 📅 Page injection time:',
                            new Date().toISOString(),
                        )
                        console.log('🎥 🌐 Page URL:', window.location.href)
                        console.log(
                            '🎥 📄 Page ready state:',
                            document.readyState,
                        )

                        // Strategy 1: Override getUserMedia immediately to prevent "Camera not found"
                        const originalGetUserMedia =
                            navigator.mediaDevices.getUserMedia

                        // Load user image if provided
                        let userImage = null
                        let imageLoaded = false

                        if (config.userImageUrl && config.showUserImage) {
                            userImage = new Image()
                            userImage.crossOrigin = 'anonymous'
                            userImage.onload = () => {
                                imageLoaded = true
                                console.log(
                                    '🎥 WAITING-ROOM User image loaded successfully',
                                )
                            }
                            userImage.onerror = () => {
                                console.log(
                                    '🎥 WAITING-ROOM Failed to load user image, continuing without it',
                                )
                            }
                            userImage.src = config.userImageUrl
                        }

                        navigator.mediaDevices.getUserMedia = async function (
                            constraints,
                        ) {
                            console.log(
                                '🎥 ===== WAITING-ROOM getUserMedia INTERCEPTED =====',
                            )
                            console.log(
                                '🎥 Constraints:',
                                JSON.stringify(constraints),
                            )

                            if (constraints.video) {
                                console.log(
                                    '🎥 🎬 WAITING-ROOM VIDEO REQUEST DETECTED!',
                                )

                                // Create virtual camera if not already created
                                if (!window.__virtualCamera) {
                                    console.log(
                                        '🎥 🚀 WAITING-ROOM Creating virtual camera on demand...',
                                    )

                                    // Create virtual camera canvas
                                    const canvas =
                                        document.createElement('canvas')
                                    canvas.width = 1280
                                    canvas.height = 720
                                    canvas.style.position = 'absolute'
                                    canvas.style.top = '-9999px'
                                    canvas.style.left = '-9999px'
                                    document.body.appendChild(canvas)

                                    const ctx = canvas.getContext('2d')
                                    if (!ctx) {
                                        console.error(
                                            'Failed to get canvas context',
                                        )
                                        return originalGetUserMedia.call(
                                            this,
                                            constraints,
                                        )
                                    }

                                    // Animation variables
                                    let frameCount = 0
                                    let startTime = Date.now()

                                    // Animation function
                                    function animate() {
                                        // Clear canvas
                                        ctx.fillStyle = '#000'
                                        ctx.fillRect(
                                            0,
                                            0,
                                            canvas.width,
                                            canvas.height,
                                        )

                                        // Create animated background
                                        const time =
                                            (Date.now() - startTime) / 1000
                                        const hue = (time * 30) % 360
                                        ctx.fillStyle = `hsl(${hue}, 70%, 50%)`
                                        ctx.fillRect(
                                            0,
                                            0,
                                            canvas.width,
                                            canvas.height,
                                        )

                                        // Draw user image if available
                                        if (
                                            userImage &&
                                            imageLoaded &&
                                            config.showUserImage
                                        ) {
                                            ctx.save()
                                            ctx.globalAlpha =
                                                config.imageOpacity || 0.8

                                            const imageSize =
                                                Math.min(
                                                    canvas.width,
                                                    canvas.height,
                                                ) * 0.3
                                            let x, y

                                            switch (config.imagePosition) {
                                                case 'center':
                                                    x =
                                                        (canvas.width -
                                                            imageSize) /
                                                        2
                                                    y =
                                                        (canvas.height -
                                                            imageSize) /
                                                        2
                                                    break
                                                case 'corner':
                                                    x = 20
                                                    y = 20
                                                    break
                                                case 'background':
                                                    x =
                                                        (canvas.width -
                                                            imageSize) /
                                                        2
                                                    y =
                                                        (canvas.height -
                                                            imageSize) /
                                                        2
                                                    ctx.globalAlpha = 0.3
                                                    break
                                                default:
                                                    x = 20
                                                    y = 20
                                            }

                                            // Draw rounded rectangle background for image
                                            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
                                            ctx.beginPath()
                                            ctx.roundRect(
                                                x - 10,
                                                y - 10,
                                                imageSize + 20,
                                                imageSize + 20,
                                                10,
                                            )
                                            ctx.fill()

                                            // Draw the image
                                            ctx.drawImage(
                                                userImage,
                                                x,
                                                y,
                                                imageSize,
                                                imageSize,
                                            )
                                            ctx.restore()
                                        }

                                        // Add some animated elements
                                        ctx.fillStyle =
                                            'rgba(255, 255, 255, 0.8)'
                                        ctx.font = '48px Arial'
                                        ctx.textAlign = 'center'
                                        ctx.fillText(
                                            'Virtual Camera',
                                            canvas.width / 2,
                                            canvas.height / 2 - 50,
                                        )

                                        ctx.font = '24px Arial'
                                        ctx.fillText(
                                            `Frame: ${frameCount}`,
                                            canvas.width / 2,
                                            canvas.height / 2,
                                        )
                                        ctx.fillText(
                                            new Date().toLocaleTimeString(),
                                            canvas.width / 2,
                                            canvas.height / 2 + 50,
                                        )

                                        frameCount++
                                        requestAnimationFrame(animate)
                                    }

                                    // Start animation
                                    animate()

                                    // Create media stream from canvas
                                    const stream = canvas.captureStream(30)

                                    // Store reference
                                    window.__virtualCamera = {
                                        canvas,
                                        stream,
                                        originalGetUserMedia,
                                    }

                                    console.log(
                                        '🎥 ✅ WAITING-ROOM Virtual camera created and ready',
                                    )
                                }

                                console.log(
                                    '🎥 ✅ WAITING-ROOM Providing virtual video stream',
                                )
                                console.log(
                                    '🎥 Stream tracks:',
                                    window.__virtualCamera.stream
                                        .getTracks()
                                        .map((t) => t.kind),
                                )
                                return window.__virtualCamera.stream
                            } else {
                                console.log(
                                    '🎥 📻 WAITING-ROOM Audio-only request, not intercepting',
                                )
                            }

                            console.log(
                                '🎥 🔄 WAITING-ROOM Falling back to original getUserMedia',
                            )
                            try {
                                const result = await originalGetUserMedia.call(
                                    this,
                                    constraints,
                                )
                                console.log(
                                    '🎥 ✅ WAITING-ROOM Original getUserMedia succeeded',
                                )
                                return result
                            } catch (error) {
                                console.log(
                                    '🎥 ❌ WAITING-ROOM Original getUserMedia failed:',
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                                )
                                throw error
                            }
                        }

                        console.log(
                            '🎥 ✅ WAITING-ROOM Virtual camera getUserMedia override installed',
                        )

                        // Strategy 3: Also override enumerateDevices to show our virtual camera
                        const originalEnumerateDevices =
                            navigator.mediaDevices.enumerateDevices
                        navigator.mediaDevices.enumerateDevices =
                            async function () {
                                console.log(
                                    '🎥 📋 WAITING-ROOM enumerateDevices called - intercepting...',
                                )
                                const devices =
                                    await originalEnumerateDevices.call(this)
                                console.log(
                                    '🎥 📋 WAITING-ROOM Original devices:',
                                    devices.map((d) => ({
                                        kind: d.kind,
                                        label: d.label,
                                    })),
                                )

                                // Add our virtual camera to the list
                                const virtualVideoDevice = {
                                    deviceId: 'virtual-camera-123',
                                    kind: 'videoinput' as MediaDeviceKind,
                                    label: 'Virtual Camera (Meeting Bot)',
                                    groupId: 'virtual-camera-group',
                                    toJSON: function () {
                                        return this
                                    },
                                } as MediaDeviceInfo

                                const enhancedDevices = [
                                    ...devices,
                                    virtualVideoDevice,
                                ]
                                console.log(
                                    '🎥 📋 WAITING-ROOM Enhanced devices with virtual camera:',
                                    enhancedDevices.map((d) => ({
                                        kind: d.kind,
                                        label: d.label,
                                    })),
                                )
                                return enhancedDevices
                            }
                        console.log(
                            '🎥 ✅ WAITING-ROOM Virtual camera enumerateDevices override installed',
                        )

                        // Strategy 4: Force camera detection by periodically calling getUserMedia
                        console.log(
                            '🎥 🔄 WAITING-ROOM Setting up periodic camera detection...',
                        )
                        setTimeout(() => {
                            console.log(
                                '🎥 🔄 WAITING-ROOM Triggering periodic camera detection...',
                            )
                            navigator.mediaDevices
                                .getUserMedia({ video: true })
                                .then((stream) => {
                                    console.log(
                                        '🎥 ✅ WAITING-ROOM Periodic camera detection succeeded',
                                    )
                                    stream
                                        .getTracks()
                                        .forEach((track) => track.stop())
                                })
                                .catch((error) => {
                                    console.log(
                                        '🎥 ❌ WAITING-ROOM Periodic camera detection failed:',
                                        error.message,
                                    )
                                })
                        }, 2000) // Wait 2 seconds then try to detect camera
                    })

                    console.info(
                        'Virtual camera getUserMedia override installed successfully',
                    )
                } catch (error) {
                    console.error('Failed to inject virtual camera:', error)
                    console.warn('Continuing without virtual camera...')
                }
            }
        } catch (error) {
            console.error('Failed to open meeting page:', {
                error,
                message:
                    error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
            })

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
                    GLOBAL.setError(MeetingEndReason.TimeoutWaitingToStart)
                    const timeoutError = new Error(
                        'Waiting room timeout reached',
                    )
                    console.error('Waiting room timeout reached', timeoutError)
                    reject(timeoutError)
                }
            }, timeoutMs)

            const checkStopSignal = setInterval(() => {
                if (GLOBAL.getEndReason() === MeetingEndReason.ApiRequest) {
                    clearInterval(checkStopSignal)
                    clearTimeout(timeout)
                    GLOBAL.setError(MeetingEndReason.ApiRequest)
                    const apiError = new Error('API request to stop recording')
                    reject(apiError)
                }
            }, 1000)

            this.context.provider
                .joinMeeting(
                    this.context.playwrightPage,
                    () => GLOBAL.getEndReason() === MeetingEndReason.ApiRequest,
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

    private startDialogObserver() {
        // Use the global observer instead of creating a local one
        // Stopping the dialog observer is done in the cleanup state
        if (this.context.dialogObserver) {
            console.info(
                `Starting global dialog observer in state ${this.constructor.name}`,
            )
            this.context.dialogObserver.setupGlobalDialogObserver()
        } else {
            console.warn(
                `Global dialog observer not available in state ${this.constructor.name}`,
            )
        }
    }
}
