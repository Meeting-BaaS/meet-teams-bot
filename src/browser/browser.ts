import { BrowserContext, chromium } from '@playwright/test'
import { GLOBAL } from '../singleton'
import { formatError } from '../utils/Logger'

// Chromium launch flags shared by both the CloakBrowser (Meet) and the official
// Chrome (Teams/other) paths.
function buildChromeArgs(
    windowWidth: number,
    windowHeight: number,
    proxyUrl?: string | null,
): string[] {
    return [
        // Window size and position - must match Xvfb display exactly
        `--window-size=${windowWidth},${windowHeight}`,
        '--window-position=0,0',

        // Security configurations
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--lang=en-US', // Force English language with region code
        '--accept-lang=en-US,en', // Accept English for HTTP requests

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

        // Route browser traffic through the local toggle proxy when running with
        // a residential upstream. The local proxy is on 127.0.0.1; allowlist +
        // setDirectMode() decide what actually hits the upstream.
        ...(proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
    ]
}

export async function openBrowser(
    proxyUrl?: string | null,
): Promise<{ browser: BrowserContext }> {
    // Resolution configuration from environment variable
    // Defaults to 720p if RESOLUTION is not set or invalid
    const resolution = process.env.RESOLUTION || '720'
    const { width, height } =
        resolution === '1080'
            ? { width: 1920, height: 1080 }
            : { width: 1280, height: 720 }

    // Window size must match Xvfb display size (includes browser UI ~140px)
    // Xvfb is 1280x860 for 720p or 1920x1220 for 1080p
    const windowWidth = width
    const windowHeight = resolution === '1080' ? 1220 : 860

    const args = buildChromeArgs(windowWidth, windowHeight, proxyUrl)

    try {
        // --- Google Meet: CloakBrowser (stealth Chromium + humanized input) ---
        // Meet's reCAPTCHA-Enterprise-style join scoring blocks plain Chromium/CDP
        // input, so Meet alone uses CloakBrowser with humanize. dehumanize() is
        // applied once admitted (see WaitingRoomState).
        if (GLOBAL.get().meetingProvider === 'Meet') {
            console.log('Launching CloakBrowser persistent context (Meet)...')
            // esbuild converts import() to require() under "module: commonjs",
            // which breaks ESM-only packages. The Function constructor prevents
            // that transpilation.
            const dynamicImport = new Function(
                'specifier',
                'return import(specifier)',
            )
            const { launchPersistentContext } =
                await dynamicImport('cloakbrowser')
            const context = await launchPersistentContext({
                userDataDir: '',
                headless: false,
                viewport: { width, height },
                locale: 'en-US',
                humanize: true,
                ...(proxyUrl ? { proxy: proxyUrl } : {}),
                args: [
                    ...args,
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--disable-gpu-compositing',
                ],
                contextOptions: {
                    permissions: ['microphone', 'camera'],
                    ignoreHTTPSErrors: true,
                    acceptDownloads: true,
                    bypassCSP: true,
                },
            })
            console.log('✅ CloakBrowser launched (Meet)')
            return { browser: context as unknown as BrowserContext }
        }

        // --- Teams / everything else: official Chrome (unchanged legacy path) ---
        // Teams does not have Meet's anti-bot join scoring, so it keeps the
        // proven official-Chrome launch (no CloakBrowser, no humanize).
        const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
        console.log(
            `Launching official Chrome persistent context (${GLOBAL.get().meetingProvider}) at ${chromePath}...`,
        )
        const context = await chromium.launchPersistentContext('', {
            headless: false,
            viewport: { width, height },
            executablePath: chromePath,
            locale: 'en-US', // Set locale for Playwright context
            args,
            permissions: ['microphone', 'camera'],
            ignoreHTTPSErrors: true,
            acceptDownloads: true,
            bypassCSP: true,
            timeout: 120000,
        })

        console.log('✅ Chromium launched with PulseAudio configuration')
        return { browser: context }
    } catch (error) {
        console.error('Failed to open browser:', formatError(error))
        throw error
    }
}
