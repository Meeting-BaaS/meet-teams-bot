import { BrowserContext, chromium } from '@playwright/test'

type Resolution = {
    width: number
    height: number
}

const P480: Resolution = {
    width: 854,
    height: 480,
}

const P720: Resolution = {
    width: 1280,
    height: 720,
}

var RESOLUTION: Resolution = P720

export async function openBrowser(
    lowResolution: boolean,
    slowMo: boolean = false,
): Promise<{ browser: BrowserContext}> {
    if (lowResolution) {
        RESOLUTION = P480
    }

    const width = RESOLUTION.width
    const height = RESOLUTION.height

    try {
        console.log('Launching persistent context with exact extension args...')
        console.log('Resolution:', width, 'x', height)
        console.log('Environment variables:')
        console.log('  DISPLAY:', process.env.DISPLAY)
        console.log('  PLAYWRIGHT_BROWSERS_PATH:', process.env.PLAYWRIGHT_BROWSERS_PATH)
        console.log('  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:', process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)
        console.log('  NODE_ENV:', process.env.NODE_ENV)

        const botCameraDevice = `/dev/video${process.env.BOT_CAMERA_NUM || '10'}`
        console.log(`  Using camera device: ${botCameraDevice}`)

        // Use the correct executable path that actually exists
        const executablePath = '/nix/store/y53pinyaz63p6hs8acbgjnn585wnnr08-playwright-browsers-chromium/chromium-1169/chrome-linux/chrome'
        console.log(`  Browser executable path: ${executablePath}`)

        const context = await chromium.launchPersistentContext('', {
            headless: false,
            viewport: { width, height },
            executablePath: executablePath,
            args: [
                // Security configurations
                '--no-sandbox',
                '--disable-setuid-sandbox',

                // WebRTC optimizations (required for meeting audio/video capture)
                '--no-sandbox',
                '--disable-rtc-smoothness-algorithm',
                '--disable-webrtc-hw-decoding',
                '--disable-webrtc-hw-encoding',
                '--disable-blink-features=AutomationControlled',
                '--disable-setuid-sandbox',
                '--autoplay-policy=no-user-gesture-required',
                '--disable-background-timer-throttling',
                '--enable-features=SharedArrayBuffer',
                '--ignore-certificate-errors',
                '--allow-insecure-localhost',
                '--disable-blink-features=TrustedDOMTypes',
                '--disable-features=TrustedScriptTypes',
                '--disable-features=TrustedHTML',
                '--use-fake-device-for-media-stream',
                `--use-file-for-fake-video-capture=${botCameraDevice}`,
            ],
            slowMo: slowMo ? 100 : undefined,
            permissions: ['microphone', 'camera'],
            ignoreHTTPSErrors: true,
            acceptDownloads: true,
            bypassCSP: true,
            timeout: 120000, // 2 minutes
        })

        console.log('Creating main page for meeting interaction...')

        // Create a main page for meeting interaction
        const mainPage = await context.newPage()

        console.log('Browser launched successfully')

        return { browser: context}
    } catch (error) {
        console.error('Failed to open browser:', error)
        console.error('Error name:', (error as Error).name)
        console.error('Error message:', (error as Error).message)
        console.error('Error stack:', (error as Error).stack)
        
        // Log additional debugging information
        if ((error as Error).message) {
            console.error('Full error message:', (error as Error).message)
        }
        
        // Check if it's a specific Playwright error
        if ((error as Error).name === 'TimeoutError') {
            console.error('Browser launch timed out - this might be a display or environment issue')
        } else if ((error as Error).message && (error as Error).message.includes('ENOENT')) {
            console.error('File not found error - this might be a missing browser binary')
        } else if ((error as Error).message && (error as Error).message.includes('permission')) {
            console.error('Permission error - this might be a sandbox or display access issue')
        }
        
        throw error
    }
}
