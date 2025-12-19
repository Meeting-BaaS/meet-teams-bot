import { chromium, BrowserContext } from 'rebrowser-playwright'
import { formatError } from '../utils/Logger'

// rebrowser-playwright has anti-detection patches built-in
// It patches the Runtime.enable leak that Cloudflare/DataDome use to detect automation
console.log('🎭 Using rebrowser-playwright with anti-detection patches')

export async function openBrowser(
    slowMo: boolean = false,
): Promise<{ browser: BrowserContext }> {
    // Resolution configuration from environment variable
    // Defaults to 720p if RESOLUTION is not set or invalid
    const resolution = process.env.RESOLUTION || '720'
    const { width, height } =
        resolution === '1080' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }

    console.log(`🎭 rebrowser-playwright mode: viewport=${width}x${height}`)

    try {
        console.log('Launching persistent context with exact extension args...')

        // Get Chrome path from environment variable or use default
        const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
        console.log(`🔍 Using Chrome path: ${chromePath}`)

        // Use a persistent profile directory - real users have browser history/cookies
        // Options:
        //   1. Set CHROME_PROFILE_DIR to your real Chrome profile (e.g., ~/.config/google-chrome/Default)
        //   2. Set CHROME_PROFILE_DIR to a directory where you've manually signed into Google
        //   3. Leave empty for fresh profile (will likely be detected as bot)
        const profileDir = process.env.CHROME_PROFILE_DIR || ''
        if (profileDir) {
            console.log(`🎭 Using persistent profile: ${profileDir}`)
        } else {
            console.log(`⚠️ No CHROME_PROFILE_DIR set - using fresh profile (may be detected as bot)`)
        }

        const context = await chromium.launchPersistentContext(profileDir, {
            headless: false,
            viewport: { width, height },
            executablePath: chromePath,
            locale: 'en-US',
            // Let rebrowser-playwright handle user agent and headers naturally
            args: [
                // Security configurations
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--lang=en-US', // Force English language with region code
                '--accept-lang=en-US,en', // Accept English for HTTP requests

                // ========================================
                // ANTI-DETECTION (from attendee-labs approach)
                // ========================================
                '--disable-dev-shm-usage', // Avoid /dev/shm issues in containers
                `--window-size=${width},${height}`, // Match viewport to window size
                '--disable-gpu', // Avoid WebGL fingerprinting
                '--use-fake-device-for-media-stream', // Chrome's built-in fake camera/mic (looks more legitimate)
                '--use-fake-ui-for-media-stream', // Auto-grant media permissions without prompts
                '--disable-blink-features=AutomationControlled', // Remove navigator.webdriver=true
                '--disable-infobars', // Hide "Chrome is being controlled" infobar
                '--disable-extensions', // Prevent extension fingerprinting

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

        console.log('✅ Chromium launched with rebrowser-playwright')

        // Optional: Inject Google cookies from environment variable
        // Set GOOGLE_COOKIES as JSON array: [{"name":"...", "value":"...", "domain":".google.com", ...}]
        const cookiesJson = process.env.GOOGLE_COOKIES
        if (cookiesJson) {
            try {
                const cookies = JSON.parse(cookiesJson)
                await context.addCookies(cookies)
                console.log(`🍪 Injected ${cookies.length} cookies from GOOGLE_COOKIES`)
            } catch (e) {
                console.error('❌ Failed to parse/inject GOOGLE_COOKIES:', e)
            }
        }

        return { browser: context }
    } catch (error) {
        console.error('Failed to open browser:', formatError(error))
        throw error
    }
}
