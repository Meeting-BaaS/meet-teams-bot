const { chromium } = require('playwright')
const { CAPTCHAHandler } = require('./build/src/utils/CAPTCHAHandler')

async function testCAPTCHADetection() {
    console.log('🧪 Testing CAPTCHA detection...')

    const browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    const context = await browser.newContext()
    const page = await context.newPage()

    try {
        // Test 1: Navigate to a simple page and check CAPTCHA detection
        console.log('📄 Test 1: Checking CAPTCHA detection on a simple page...')
        await page.goto('https://example.com')

        const captchaHandler = new CAPTCHAHandler()
        const result = await captchaHandler.handleCAPTCHA(page)

        console.log('✅ CAPTCHA detection result:', result)

        // Test 2: Navigate to Teams and check for CAPTCHA
        console.log('📄 Test 2: Checking CAPTCHA detection on Teams...')
        await page.goto('https://teams.microsoft.com')

        const teamsResult = await captchaHandler.handleCAPTCHA(page)
        console.log('✅ Teams CAPTCHA detection result:', teamsResult)

        // Test 3: Check page content
        console.log('📄 Test 3: Analyzing page content...')
        const pageText = await page.evaluate(() =>
            document.body.innerText.substring(0, 500),
        )
        console.log('📝 Page text preview:', pageText)

        // Test 4: Check for common elements
        console.log('📄 Test 4: Checking for common elements...')
        const elements = await page.evaluate(() => {
            const found = []
            const selectors = [
                '[role="dialog"]',
                '.modal',
                '[aria-modal="true"]',
                'input[type="text"]',
                'button',
                'img',
            ]

            selectors.forEach((selector) => {
                const elements = document.querySelectorAll(selector)
                if (elements.length > 0) {
                    found.push(`${selector}: ${elements.length} found`)
                }
            })

            return found
        })

        console.log('🔍 Found elements:', elements)
    } catch (error) {
        console.error('❌ Test failed:', error)
    } finally {
        await browser.close()
    }
}

testCAPTCHADetection().catch(console.error)
