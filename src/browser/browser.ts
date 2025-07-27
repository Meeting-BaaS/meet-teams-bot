import { BrowserContext, chromium } from '@playwright/test'

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
                '--enable-webrtc-capture-video', // Ensure WebRTC can capture video
                '--force-webrtc-ip-handling-policy=default', // Better WebRTC handling

                // Fake camera configuration
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--use-file-for-fake-video-capture=/app/virtual-camera/test_logo.mjpeg',
                '--use-file-for-fake-audio-capture=/dev/zero',

                // General Docker configuration
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--ignore-certificate-errors',
                '--enable-logging=stderr',
                '--vmodule=*/webrtc/*=2,*/libjingle/*=2',

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
        return { browser: context }
    } catch (error) {
        console.error('Failed to open browser:', error)
        throw error
    }
}
