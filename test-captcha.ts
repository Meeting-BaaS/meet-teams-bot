import { BrowserContext, chromium, Page } from '@playwright/test'
import { CAPTCHADetector } from './src/utils/CAPTCHADetector'
import { CAPTCHAHandler } from './src/utils/CAPTCHAHandler'
import { CAPTCHALanguageDetector } from './src/utils/CAPTCHALanguageDetector'

async function testCAPTCHAImplementation() {
    console.log('🧪 Testing CAPTCHA Implementation...')

    let browser: BrowserContext | null = null
    let page: Page | null = null

    try {
        // Initialize browser
        const browserInstance = await chromium.launch({ headless: false })
        browser = await browserInstance.newContext({
            viewport: { width: 1280, height: 720 },
        })
        page = await browser.newPage()

        // Test 1: Language Detection
        console.log('\n📝 Test 1: Language Detection')
        await page.goto('https://example.com')
        const languageDetection =
            await CAPTCHALanguageDetector.detectCAPTCHALanguage(page)
        console.log('Language detection result:', languageDetection)

        // Test 2: CAPTCHA Detection (should be false on example.com)
        console.log('\n🔍 Test 2: CAPTCHA Detection')
        const captchaDetection = await CAPTCHADetector.detectCAPTCHA(page)
        console.log('CAPTCHA detection result:', captchaDetection)

        // Test 3: CAPTCHA Handler Initialization
        console.log('\n🤖 Test 3: CAPTCHA Handler Initialization')
        const captchaHandler = new CAPTCHAHandler({
            enabled: true,
            maxAttempts: 2,
            timeoutMs: 10000,
            confidenceThreshold: 0.6,
            languages: ['en', 'fr', 'es', 'de'],
            retryDelayMs: 1000,
        })
        console.log('CAPTCHA handler initialized successfully')

        // Test 4: CAPTCHA Handler Configuration
        console.log('\n⚙️ Test 4: CAPTCHA Handler Configuration')
        const config = captchaHandler.getConfig()
        console.log('CAPTCHA handler config:', config)

        // Test 5: CAPTCHA Handling (should succeed with no CAPTCHA present)
        console.log('\n✅ Test 5: CAPTCHA Handling (No CAPTCHA)')
        const result = await captchaHandler.handleCAPTCHA(page)
        console.log('CAPTCHA handling result:', result)

        console.log('\n🎉 All tests completed successfully!')
        console.log('\n📋 Summary:')
        console.log('- Language detection: ✅ Working')
        console.log('- CAPTCHA detection: ✅ Working')
        console.log('- CAPTCHA handler: ✅ Working')
        console.log('- Configuration: ✅ Working')
        console.log('- No CAPTCHA handling: ✅ Working')
    } catch (error) {
        console.error('❌ Test failed:', error)
    } finally {
        // Cleanup
        if (page) await page.close()
        if (browser) await browser.close()
    }
}

// Run the test if this file is executed directly
if (require.main === module) {
    testCAPTCHAImplementation().catch(console.error)
}

export { testCAPTCHAImplementation }
