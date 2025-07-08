import { BrowserContext, chromium } from '@playwright/test'

export async function openBrowser(
    slowMo: boolean = false,
): Promise<{ browser: BrowserContext }> {
    const width = 1280 // 640
    const height = 720 // 480

    // Get device configuration from environment variables
    const botDeviceId = process.env.BOT_DEVICE_ID
    const display = process.env.DISPLAY || ':99'
    const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

    console.log('🔧 Browser config:')
    console.log(`  Display: ${display}`)
    console.log(`  Chromium Path: ${chromiumPath || 'default'}`)
    console.log(`  Bot Device ID: ${botDeviceId || 'not set'}`)

    try {
        console.log('Launching persistent context with exact extension args...')

        // Set display environment variable
        if (display) {
            process.env.DISPLAY = display
        }

        const launchOptions: any = {
            headless: false,
            viewport: { width, height },
            args: [
                // Security configurations
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-rtc-smoothness-algorithm',
                '--disable-webrtc-hw-decoding',
                '--disable-webrtc-hw-encoding',
                '--autoplay-policy=no-user-gesture-required',
                
                // Performance and resource management optimizations
                '--disable-blink-features=AutomationControlled',
                '--disable-background-timer-throttling',
                '--enable-features=SharedArrayBuffer',
                '--memory-pressure-off',              // Disable memory pressure handling for consistent performance
                '--max_old_space_size=4096',          // Increase V8 heap size to 4GB for large meetings
                '--disable-background-networking',    // Reduce background network activity
                '--disable-features=TranslateUI',     // Disable translation features to save resources
                '--disable-features=AutofillServerCommunication', // Disable autofill to reduce network usage
                '--disable-component-extensions-with-background-pages', // Reduce background extension overhead
                '--disable-default-apps',             // Disable default Chrome apps
                '--renderer-process-limit=4',         // Limit renderer processes to prevent resource exhaustion
                '--disable-ipc-flooding-protection',  // Improve IPC performance for high-frequency operations
                '--aggressive-cache-discard',         // Enable aggressive cache management for memory efficiency
                '--disable-features=MediaRouter',     // Disable media router for reduced overhead
                
                // Certificate and security optimizations for meeting platforms
                '--ignore-certificate-errors',
                '--allow-insecure-localhost',
                '--disable-blink-features=TrustedDOMTypes',
                '--disable-features=TrustedScriptTypes',
                '--disable-features=TrustedHTML',
            ],
            slowMo: slowMo ? 100 : undefined,
            permissions: ['microphone', 'camera'],
            ignoreHTTPSErrors: true,
            acceptDownloads: true,
            bypassCSP: true,
            timeout: 120000,
        }

        // Use NixOS Chromium path if provided
        if (chromiumPath) {
            console.log(`🔧 Using NixOS Chromium: ${chromiumPath}`)
            launchOptions.executablePath = chromiumPath
        } else {
            console.log('🔧 Using default Chromium from Playwright')
        }

        const context = await chromium.launchPersistentContext('', launchOptions)

        return { browser: context }
    } catch (error) {
        console.error('Failed to open browser:', error)
        throw error
    }
}
