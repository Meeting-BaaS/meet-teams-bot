import { ChildProcess } from 'child_process'
import { Page } from 'playwright'

// Extend Window interface for virtual camera
declare global {
    interface Window {
        __virtualCamera?: {
            canvas: HTMLCanvasElement
            stream: MediaStream
            originalGetUserMedia: typeof navigator.mediaDevices.getUserMedia
        }
    }
}

export interface VirtualCameraConfig {
    width: number
    height: number
    fps: number
    type: 'animated' | 'static' | 'video' | 'screen'
    content?: string // URL, file path, or content description
    userImageUrl?: string // URL to user's branding image
    showUserImage?: boolean // Whether to display user image
    imagePosition?: 'center' | 'corner' | 'background' // Where to position the image
    imageOpacity?: number // Opacity of the user image (0-1)
}

export class VirtualCamera {
    private static instance: VirtualCamera
    private page: Page | null = null
    private ffmpegProcess: ChildProcess | null = null
    private isActive: boolean = false
    private config: VirtualCameraConfig

    constructor(config: Partial<VirtualCameraConfig> = {}) {
        this.config = {
            width: 1280,
            height: 720,
            fps: 30,
            type: 'animated',
            showUserImage: false,
            imagePosition: 'corner',
            imageOpacity: 0.8,
            ...config,
        }
        VirtualCamera.instance = this
    }

    public static getInstance(): VirtualCamera {
        if (!VirtualCamera.instance) {
            VirtualCamera.instance = new VirtualCamera()
        }
        return VirtualCamera.instance
    }

    /**
     * Start the virtual camera with web-based content generation
     */
    public async start(
        page: Page,
        config?: Partial<VirtualCameraConfig>,
    ): Promise<void> {
        if (this.isActive) {
            console.log('Virtual camera already active')
            return
        }

        if (config) {
            this.config = { ...this.config, ...config }
        }

        this.page = page
        this.isActive = true

        console.log('🎥 Starting web-based virtual camera...')

        // Inject virtual camera functionality into the main page
        await this.injectVirtualCameraIntoPage()

        console.log('✅ Virtual camera started successfully')
    }

    /**
     * Stop the virtual camera
     */
    public async stop(): Promise<void> {
        if (!this.isActive) {
            return
        }

        console.log('🛑 Stopping virtual camera...')

        // Stop FFmpeg process if running
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGTERM')
            this.ffmpegProcess = null
        }

        // Remove virtual camera from the page
        if (this.page) {
            await this.removeVirtualCameraFromPage()
        }

        this.isActive = false
        console.log('✅ Virtual camera stopped')
    }

    /**
     * Inject virtual camera functionality into the main page
     * This makes the virtual camera available as a media device
     */
    private async injectVirtualCameraIntoPage(): Promise<void> {
        if (!this.page) {
            throw new Error('Page not initialized')
        }

        // Inject the virtual camera script into the page with config
        await this.page.addInitScript(
            this.config,
            (config: VirtualCameraConfig) => {
                // Create virtual camera canvas
                const canvas = document.createElement('canvas')
                canvas.width = config.width || 1280
                canvas.height = config.height || 720
                canvas.style.position = 'absolute'
                canvas.style.top = '-9999px'
                canvas.style.left = '-9999px'
                document.body.appendChild(canvas)

                const ctx = canvas.getContext('2d')
                if (!ctx) return

                // Animation variables
                let frameCount = 0
                let startTime = Date.now()
                let userImage = null
                let imageLoaded = false

                // Load user image if provided
                if (config.userImageUrl && config.showUserImage) {
                    userImage = new Image()
                    userImage.crossOrigin = 'anonymous'
                    userImage.onload = () => {
                        imageLoaded = true
                        console.log('🎥 User image loaded successfully')
                    }
                    userImage.onerror = () => {
                        console.log(
                            '🎥 Failed to load user image, continuing without it',
                        )
                    }
                    userImage.src = config.userImageUrl
                }

                // Animation function
                function animate() {
                    // Clear canvas
                    ctx.fillStyle = '#000'
                    ctx.fillRect(0, 0, canvas.width, canvas.height)

                    // Create animated background
                    const time = (Date.now() - startTime) / 1000
                    const hue = (time * 30) % 360
                    ctx.fillStyle = `hsl(${hue}, 70%, 50%)`
                    ctx.fillRect(0, 0, canvas.width, canvas.height)

                    // Draw user image if available
                    if (userImage && imageLoaded && config.showUserImage) {
                        ctx.save()
                        ctx.globalAlpha = config.imageOpacity || 0.8

                        const imageSize =
                            Math.min(canvas.width, canvas.height) * 0.3
                        let x, y

                        switch (config.imagePosition) {
                            case 'center':
                                x = (canvas.width - imageSize) / 2
                                y = (canvas.height - imageSize) / 2
                                break
                            case 'corner':
                                x = 20
                                y = 20
                                break
                            case 'background':
                                x = (canvas.width - imageSize) / 2
                                y = (canvas.height - imageSize) / 2
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
                        ctx.drawImage(userImage, x, y, imageSize, imageSize)
                        ctx.restore()
                    }

                    // Add some animated elements
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
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

                // Override getUserMedia to provide our virtual camera
                const originalGetUserMedia = navigator.mediaDevices.getUserMedia
                navigator.mediaDevices.getUserMedia = async function (
                    constraints,
                ) {
                    if (constraints.video) {
                        console.log(
                            '🎥 Virtual camera: Providing virtual video stream',
                        )
                        return stream
                    }
                    return originalGetUserMedia.call(this, constraints)
                }

                // Store reference for cleanup
                window.__virtualCamera = {
                    canvas,
                    stream,
                    originalGetUserMedia,
                }

                console.log('🎥 Virtual camera injected successfully')
            },
        )

        console.log('📹 Virtual camera stream available as media device')
    }

    /**
     * Remove virtual camera from the page
     */
    private async removeVirtualCameraFromPage(): Promise<void> {
        if (!this.page) return

        await this.page.evaluate(() => {
            if (window.__virtualCamera) {
                // Restore original getUserMedia
                navigator.mediaDevices.getUserMedia =
                    window.__virtualCamera.originalGetUserMedia

                // Remove canvas
                if (window.__virtualCamera.canvas) {
                    window.__virtualCamera.canvas.remove()
                }

                // Stop stream
                if (window.__virtualCamera.stream) {
                    window.__virtualCamera.stream
                        .getTracks()
                        .forEach((track) => track.stop())
                }

                delete window.__virtualCamera
                console.log('🎥 Virtual camera removed')
            }
        })
    }

    /**
     * Change virtual camera content
     */
    public async changeContent(
        type: VirtualCameraConfig['type'],
        content?: string,
    ): Promise<void> {
        if (!this.isActive || !this.page) {
            throw new Error('Virtual camera not active')
        }

        this.config.type = type
        if (content) {
            this.config.content = content
        }

        // Update the virtual camera content
        await this.page.evaluate(
            ({ type, content }) => {
                if (window.__virtualCamera) {
                    console.log(`🔄 Virtual camera content changed to: ${type}`)
                    // You can add different content generation logic here
                }
            },
            { type, content },
        )

        console.log(`🔄 Virtual camera content changed to: ${type}`)
    }

    /**
     * Get current virtual camera status
     */
    public getStatus(): { active: boolean; config: VirtualCameraConfig } {
        return {
            active: this.isActive,
            config: this.config,
        }
    }
}
