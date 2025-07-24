import { BrowserContext, chromium, Page } from '@playwright/test'
import { VirtualCamera } from '../virtual-camera'

export async function openBrowser(
    slowMo: boolean = false,
): Promise<{ browser: BrowserContext }> {
    const width = 1280 // 640
    const height = 720 // 480

    try {
        console.log('Launching persistent context with exact extension args...')

        const context = await chromium.launchPersistentContext('', {
            headless: false,
            viewport: { width, height },
            executablePath: '/usr/bin/google-chrome',
            args: [
                // Security configurations
                '--no-sandbox',
                '--disable-setuid-sandbox',

                // ========================================
                // AUDIO CONFIGURATION FOR PULSEAUDIO
                // ========================================
                '--use-pulseaudio', // Force Chromium to use PulseAudio
                '--enable-audio-service-sandbox=false', // Disable audio service sandbox for virtual devices
                '--audio-buffer-size=2048', // Set buffer size for better audio handling
                '--disable-features=AudioServiceSandbox', // Additional sandbox disable
                '--autoplay-policy=no-user-gesture-required', // Allow autoplay for meeting platforms

                // WebRTC optimizations (required for meeting audio/video capture)
                '--disable-rtc-smoothness-algorithm',
                '--disable-webrtc-hw-decoding',
                '--disable-webrtc-hw-encoding',
                '--enable-webrtc-capture-audio', // Ensure WebRTC can capture audio
                '--force-webrtc-ip-handling-policy=default', // Better WebRTC handling

                // Performance and resource management optimizations
                '--disable-blink-features=AutomationControlled',
                '--disable-background-timer-throttling',
                '--enable-features=SharedArrayBuffer',
                '--memory-pressure-off', // Disable memory pressure handling for consistent performance
                '--max_old_space_size=4096', // Increase V8 heap size to 4GB for large meetings
                '--disable-background-networking', // Reduce background network activity
                '--disable-features=TranslateUI', // Disable translation features to save resources
                '--disable-features=AutofillServerCommunication', // Disable autofill to reduce network usage
                '--disable-component-extensions-with-background-pages', // Reduce background extension overhead
                '--disable-default-apps', // Disable default Chrome apps
                '--renderer-process-limit=4', // Limit renderer processes to prevent resource exhaustion
                '--disable-ipc-flooding-protection', // Improve IPC performance for high-frequency operations
                '--aggressive-cache-discard', // Enable aggressive cache management for memory efficiency
                '--disable-features=MediaRouter', // Disable media router for reduced overhead

                // Certificate and security optimizations for meeting platforms
                '--ignore-certificate-errors',
                '--allow-insecure-localhost',
                '--disable-blink-features=TrustedDOMTypes',
                '--disable-features=TrustedScriptTypes',
                '--disable-features=TrustedHTML',

                // Additional audio debugging (remove in production)
                '--enable-logging=stderr',
                '--log-level=1',
                '--vmodule=*audio*=3', // Enable audio debug logging
            ],
            slowMo: slowMo ? 100 : undefined,
            permissions: ['microphone', 'camera'],
            ignoreHTTPSErrors: true,
            acceptDownloads: true,
            bypassCSP: true,
            timeout: 120000,
        })

        console.log('✅ Chromium launched with PulseAudio configuration')

        // Inject virtual camera at browser context level if enabled
        console.log(
            '🔍 Checking virtual camera environment:',
            process.env.VIRTUAL_CAMERA_ENABLED,
        )
        if (process.env.VIRTUAL_CAMERA_ENABLED === 'true') {
            try {
                console.log(
                    '🎥 Injecting virtual camera at browser context level...',
                )
                console.log('🎥 About to inject virtual camera script...')

                // Strategy 1: Add init script for early injection
                await context.addInitScript(() => {
                    console.log(
                        '🎥 🎬 ===== VIRTUAL CAMERA SCRIPT EXECUTING =====',
                    )
                    console.log(
                        '🎥 📅 Script execution time:',
                        new Date().toISOString(),
                    )
                    console.log('🎥 🌐 Current URL:', window.location.href)
                    console.log(
                        '🎥 📄 Document ready state:',
                        document.readyState,
                    )
                    console.log(
                        '🎥 🎥 Virtual camera: Overriding getUserMedia immediately...',
                    )

                    // Store original getUserMedia
                    const originalGetUserMedia =
                        navigator.mediaDevices.getUserMedia

                    // Create virtual camera on first demand
                    let virtualCamera = null

                    function createVirtualCamera() {
                        console.log('🎥 🔧 createVirtualCamera() called')

                        if (virtualCamera) {
                            console.log(
                                '🎥 ✅ Virtual camera already exists, returning cached version',
                            )
                            return virtualCamera
                        }

                        console.log('🎥 🚀 Creating new virtual camera...')

                        // Wait for body to be available
                        if (!document.body) {
                            console.log(
                                '🎥 ❌ Body not ready, cannot create canvas',
                            )
                            return null
                        }

                        console.log('🎥 ✅ Body is ready, creating canvas...')

                        // Create virtual camera canvas
                        const canvas = document.createElement('canvas')
                        canvas.width = 1280
                        canvas.height = 720
                        canvas.style.position = 'absolute'
                        canvas.style.top = '-9999px'
                        canvas.style.left = '-9999px'
                        document.body.appendChild(canvas)

                        const ctx = canvas.getContext('2d')
                        if (!ctx) return

                        // Animation variables
                        let frameCount = 0
                        let startTime = Date.now()

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

                        virtualCamera = { canvas, stream }
                        console.log('🎥 Virtual camera created successfully')
                        return virtualCamera
                    }

                    // Override getUserMedia
                    navigator.mediaDevices.getUserMedia = async function (
                        constraints,
                    ) {
                        console.log('🎥 ===== getUserMedia INTERCEPTED =====')
                        console.log(
                            '🎥 Constraints:',
                            JSON.stringify(constraints),
                        )
                        console.log('🎥 Stack trace:', new Error().stack)

                        if (constraints.video) {
                            console.log('🎥 🎬 VIDEO REQUEST DETECTED!')

                            // Create virtual camera if needed
                            const camera = createVirtualCamera()
                            if (camera) {
                                console.log(
                                    '🎥 ✅ Virtual camera created successfully',
                                )
                                console.log(
                                    '🎥 📹 Returning virtual camera stream',
                                )
                                console.log(
                                    '🎥 Stream tracks:',
                                    camera.stream
                                        .getTracks()
                                        .map((t) => t.kind),
                                )
                                return camera.stream
                            } else {
                                console.log(
                                    '🎥 ❌ Failed to create virtual camera',
                                )
                            }
                        } else {
                            console.log(
                                '🎥 📻 Audio-only request, not intercepting',
                            )
                        }

                        console.log(
                            '🎥 🔄 Falling back to original getUserMedia',
                        )
                        try {
                            const result = await originalGetUserMedia.call(
                                this,
                                constraints,
                            )
                            console.log('🎥 ✅ Original getUserMedia succeeded')
                            return result
                        } catch (error) {
                            console.log(
                                '🎥 ❌ Original getUserMedia failed:',
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                            )
                            throw error
                        }
                    }

                    console.log(
                        '🎥 Virtual camera getUserMedia override installed',
                    )

                    // Strategy 2: Also override enumerateDevices to show our virtual camera
                    const originalEnumerateDevices =
                        navigator.mediaDevices.enumerateDevices
                    navigator.mediaDevices.enumerateDevices =
                        async function () {
                            console.log(
                                '🎥 📋 enumerateDevices called - intercepting...',
                            )
                            const devices =
                                await originalEnumerateDevices.call(this)
                            console.log(
                                '🎥 📋 Original devices:',
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
                                '🎥 📋 Enhanced devices with virtual camera:',
                                enhancedDevices.map((d) => ({
                                    kind: d.kind,
                                    label: d.label,
                                })),
                            )
                            return enhancedDevices
                        }
                    console.log(
                        '🎥 Virtual camera enumerateDevices override installed',
                    )
                })

                // Strategy 3: Also inject on every new page
                context.on('page', async (page) => {
                    console.log(
                        '🎥 📄 New page created, injecting virtual camera...',
                    )
                    await page.addInitScript(() => {
                        console.log(
                            '🎥 🎬 ===== PAGE-LEVEL VIRTUAL CAMERA INJECTION =====',
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

                        // Same virtual camera logic as above
                        const originalGetUserMedia =
                            navigator.mediaDevices.getUserMedia
                        let virtualCamera = null

                        function createVirtualCamera() {
                            console.log(
                                '🎥 🔧 PAGE-LEVEL createVirtualCamera() called',
                            )
                            if (virtualCamera) return virtualCamera

                            if (!document.body) {
                                console.log('🎥 ❌ Page body not ready')
                                return null
                            }

                            const canvas = document.createElement('canvas')
                            canvas.width = 1280
                            canvas.height = 720
                            canvas.style.position = 'absolute'
                            canvas.style.top = '-9999px'
                            canvas.style.left = '-9999px'
                            document.body.appendChild(canvas)

                            const ctx = canvas.getContext('2d')
                            if (!ctx) return null

                            let frameCount = 0
                            let startTime = Date.now()

                            function animate() {
                                ctx.fillStyle = '#000'
                                ctx.fillRect(0, 0, canvas.width, canvas.height)
                                const time = (Date.now() - startTime) / 1000
                                const hue = (time * 30) % 360
                                ctx.fillStyle = `hsl(${hue}, 70%, 50%)`
                                ctx.fillRect(0, 0, canvas.width, canvas.height)
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
                            animate()

                            const stream = canvas.captureStream(30)
                            virtualCamera = { canvas, stream }
                            console.log(
                                '🎥 ✅ PAGE-LEVEL Virtual camera created',
                            )
                            return virtualCamera
                        }

                        navigator.mediaDevices.getUserMedia = async function (
                            constraints,
                        ) {
                            console.log(
                                '🎥 ===== PAGE-LEVEL getUserMedia INTERCEPTED =====',
                            )
                            console.log(
                                '🎥 Constraints:',
                                JSON.stringify(constraints),
                            )

                            if (constraints.video) {
                                console.log(
                                    '🎥 🎬 PAGE-LEVEL VIDEO REQUEST DETECTED!',
                                )
                                const camera = createVirtualCamera()
                                if (camera) {
                                    console.log(
                                        '🎥 ✅ PAGE-LEVEL Returning virtual camera stream',
                                    )
                                    return camera.stream
                                }
                            }

                            console.log(
                                '🎥 🔄 PAGE-LEVEL Falling back to original getUserMedia',
                            )
                            return originalGetUserMedia.call(this, constraints)
                        }

                        console.log(
                            '🎥 ✅ PAGE-LEVEL Virtual camera override installed',
                        )
                    })
                })

                console.log(
                    '✅ Virtual camera injected at browser context level',
                )
            } catch (error) {
                console.error(
                    'Failed to inject virtual camera at browser context level:',
                    error,
                )
            }
        }

        return { browser: context }
    } catch (error) {
        console.error('Failed to open browser:', error)
        throw error
    }
}

/**
 * Start virtual camera on an existing page
 * This injects virtual camera functionality into the main meeting page
 */
export async function startVirtualCamera(
    page: Page,
    config?: {
        width?: number
        height?: number
        type?: 'animated' | 'static' | 'video' | 'screen'
        content?: string
    },
): Promise<VirtualCamera> {
    try {
        console.log('🎥 Starting virtual camera on page...')

        // Initialize virtual camera
        const virtualCamera = VirtualCamera.getInstance()

        // Start virtual camera with the page
        await virtualCamera.start(page, {
            width: config?.width || 1280,
            height: config?.height || 720,
            type: config?.type || 'animated',
            content: config?.content,
        })

        console.log('✅ Virtual camera started successfully on page')
        return virtualCamera
    } catch (error) {
        console.error('Failed to start virtual camera:', error)
        throw error
    }
}

/**
 * Stop virtual camera and close its page
 */
export async function stopVirtualCamera(
    virtualCamera: VirtualCamera,
): Promise<void> {
    try {
        await virtualCamera.stop()
        console.log('✅ Virtual camera stopped successfully')
    } catch (error) {
        console.error('Failed to stop virtual camera:', error)
        throw error
    }
}
