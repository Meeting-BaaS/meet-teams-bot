import { BrowserContext, chromium } from '@playwright/test';
import { PathManager } from '../utils/PathManager';

export async function openBrowser(
    slowMo: boolean = false,
): Promise<{ browser: BrowserContext}> {
    const width = 1280
    const height = 720

    try {
        console.log('Launching browser context with video recording...')

        const context = await chromium.launchPersistentContext('', {
            headless: false,
            viewport: { width, height },
            recordVideo: {
                dir: PathManager.getInstance().getTempPath(),
                size: { width: width, height: height },
            },
            args: [
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
            ],
            slowMo: slowMo ? 100 : undefined,
            permissions: ['microphone', 'camera'],
            ignoreHTTPSErrors: true,
            acceptDownloads: true,
            bypassCSP: true,
            timeout: 120000, // 2 minutes
        })

        console.log('Browser launched successfully with video recording')

        return { browser: context}
    } catch (error) {
        console.error('Failed to open browser:', error)
        throw error
    }
} 