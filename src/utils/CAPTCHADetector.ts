import { Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import {
    CAPTCHALanguageDetector,
    LanguageDetection,
} from './CAPTCHALanguageDetector'
import { CAPTCHASolver } from './CAPTCHASolver'
import { PathManager } from './PathManager'

export interface CAPTCHADetection {
    isPresent: boolean
    type: 'text' | 'image' | 'audio'
    confidence: number
    location: { x: number; y: number; width: number; height: number }
    language: LanguageDetection
    imagePath?: string
    screenshotPath?: string
    timestamp?: number
}

export interface CAPTCHAElement {
    selector: string
    type: 'input' | 'button' | 'image' | 'text'
    attributes: Record<string, string>
}

export class CAPTCHADetector {
    private static readonly CAPTCHA_SELECTORS = {
        // Common CAPTCHA popup selectors
        popup: [
            '[role="dialog"]',
            '.captcha-dialog',
            '.captcha-popup',
            '.verification-dialog',
            '[aria-modal="true"]',
        ],

        // CAPTCHA image selectors
        image: [
            'img[src*="captcha"]',
            'img[alt*="captcha"]',
            'img[alt*="verification"]',
            '.captcha-image',
            '.verification-image',
        ],

        // CAPTCHA input field selectors
        input: [
            'input[placeholder*="captcha"]',
            'input[placeholder*="verification"]',
            'input[name*="captcha"]',
            'input[id*="captcha"]',
            'textarea[placeholder*="captcha"]',
        ],

        // CAPTCHA button selectors
        buttons: [
            'button:has-text("Submit")',
            'button:has-text("Verify")',
            'button:has-text("Soumettre")',
            'button:has-text("Vérifier")',
            'button:has-text("Enviar")',
            'button:has-text("Verificar")',
            'button:has-text("Senden")',
            'button:has-text("Überprüfen")',
            'input[type="submit"]',
        ],
    }

    /**
     * Detect CAPTCHA presence on the page
     */
    public static async detectCAPTCHA(page: Page): Promise<CAPTCHADetection> {
        console.log('🔍 [CAPTCHADetector] Starting CAPTCHA detection...')

        try {
            // Check for common CAPTCHA indicators
            const pageText = await page.evaluate(() =>
                document.body.innerText.toLowerCase(),
            )
            console.log('🔍 [CAPTCHADetector] Page text analysis completed')

            // Log page content for debugging - differentiate HTML vs visible content
            const pageContent = await page.evaluate(() => {
                return {
                    title: document.title,
                    // What's actually visible/readable on screen
                    visibleText: document.body.innerText.substring(0, 500),
                    // HTML elements and their attributes
                    htmlElements: {
                        buttons: Array.from(
                            document.querySelectorAll(
                                'button, input[type="submit"], input[type="button"]',
                            ),
                        ).map((el) => ({
                            text: el.textContent || '',
                            placeholder: el.getAttribute('placeholder') || '',
                            value: el.getAttribute('value') || '',
                            id: el.getAttribute('id') || '',
                            class: el.getAttribute('class') || '',
                            visible: (el as HTMLElement).offsetParent !== null, // Check if element is visible
                        })),
                        inputs: Array.from(
                            document.querySelectorAll(
                                'input[type="text"], input[type="email"], textarea',
                            ),
                        ).map((el) => ({
                            placeholder: el.getAttribute('placeholder') || '',
                            name: el.getAttribute('name') || '',
                            id: el.getAttribute('id') || '',
                            class: el.getAttribute('class') || '',
                            visible: (el as HTMLElement).offsetParent !== null, // Check if element is visible
                        })),
                        images: Array.from(
                            document.querySelectorAll('img'),
                        ).map((el) => ({
                            src: el.getAttribute('src') || '',
                            alt: el.getAttribute('alt') || '',
                            title: el.getAttribute('title') || '',
                            visible: (el as HTMLElement).offsetParent !== null, // Check if element is visible
                        })),
                    },
                }
            })

            console.log(
                '📄 [CAPTCHADetector] Page title (HTML):',
                pageContent.title,
            )
            console.log(
                '👁️ [CAPTCHADetector] Visible text on screen:',
                pageContent.visibleText,
            )

            // Log visible vs hidden HTML elements
            const visibleButtons = pageContent.htmlElements.buttons.filter(
                (el) => el.visible,
            )
            const hiddenButtons = pageContent.htmlElements.buttons.filter(
                (el) => !el.visible,
            )
            const visibleInputs = pageContent.htmlElements.inputs.filter(
                (el) => el.visible,
            )
            const hiddenInputs = pageContent.htmlElements.inputs.filter(
                (el) => !el.visible,
            )
            const visibleImages = pageContent.htmlElements.images.filter(
                (el) => el.visible,
            )
            const hiddenImages = pageContent.htmlElements.images.filter(
                (el) => !el.visible,
            )

            console.log(
                '🔘 [CAPTCHADetector] Visible buttons:',
                visibleButtons
                    .map((b) => b.text || b.placeholder || b.value)
                    .filter((t) => t),
            )
            console.log(
                '🔘 [CAPTCHADetector] Hidden buttons (HTML only):',
                hiddenButtons
                    .map((b) => b.text || b.placeholder || b.value)
                    .filter((t) => t),
            )
            console.log(
                '📝 [CAPTCHADetector] Visible input fields:',
                visibleInputs
                    .map((i) => i.placeholder || i.name || i.id)
                    .filter((t) => t),
            )
            console.log(
                '📝 [CAPTCHADetector] Hidden input fields (HTML only):',
                hiddenInputs
                    .map((i) => i.placeholder || i.name || i.id)
                    .filter((t) => t),
            )
            console.log(
                '🖼️ [CAPTCHADetector] Visible images:',
                visibleImages
                    .map(
                        (img) =>
                            img.alt || img.title || img.src.substring(0, 50),
                    )
                    .filter((t) => t),
            )
            console.log(
                '🖼️ [CAPTCHADetector] Hidden images (HTML only):',
                hiddenImages
                    .map(
                        (img) =>
                            img.alt || img.title || img.src.substring(0, 50),
                    )
                    .filter((t) => t),
            )

            // Language detection
            const languageDetection =
                await CAPTCHALanguageDetector.detectCAPTCHALanguage(page)
            console.log(
                `🌐 [CAPTCHADetector] Detected language: ${languageDetection.interfaceLanguage} (confidence: ${languageDetection.confidence})`,
            )

            const keywords = CAPTCHALanguageDetector.getCAPTCHAKeywords(
                languageDetection.interfaceLanguage as
                    | 'en'
                    | 'fr'
                    | 'es'
                    | 'de',
            )
            // ofc change the keywords to the ones that are used in the page, or have an LLM to detect the keywords etc.
            // console.log(
            //     `🔑 [CAPTCHADetector] Using keywords for ${languageDetection.interfaceLanguage}:`,
            //     keywords,
            // )

            // Check for CAPTCHA keywords in page text
            const hasKeywords =
                CAPTCHALanguageDetector.containsCAPTCHAKeywords(pageText)
            console.log(
                `🔑 [CAPTCHADetector] CAPTCHA keywords found in page text: ${hasKeywords}`,
            )

            // Log which specific keywords were found
            const foundKeywords = keywords.title
                .concat(keywords.instructions)
                .concat(keywords.buttons.submit)
                .concat(keywords.buttons.refresh)
                .concat(keywords.buttons.verify)
            const detectedKeywords = foundKeywords.filter((keyword) =>
                pageText.includes(keyword.toLowerCase()),
            )
            if (detectedKeywords.length > 0) {
                console.log(
                    '🎯 [CAPTCHADetector] Detected keywords:',
                    detectedKeywords,
                )
            } else {
                console.log(
                    '🔍 [CAPTCHADetector] No CAPTCHA keywords detected in page text',
                )
            }

            if (!hasKeywords) {
                console.log(
                    '🔍 [CAPTCHADetector] No CAPTCHA keywords detected, checking for visual elements...',
                )
            }

            // Check for visual CAPTCHA elements
            let captchaFound = false
            let captchaType: 'text' | 'image' | 'audio' = 'text'
            let captchaSelector = ''

            // Check for text-based CAPTCHA input fields
            for (const selector of Object.values(
                this.CAPTCHA_SELECTORS.input,
            )) {
                try {
                    const element = await page.$(selector)
                    if (element) {
                        captchaFound = true
                        captchaType = 'text'
                        captchaSelector = selector
                        console.log(
                            `✅ [CAPTCHADetector] Text CAPTCHA input found with selector: ${selector}`,
                        )
                        break
                    }
                } catch (error) {
                    console.log(
                        `⚠️ [CAPTCHADetector] Error checking selector ${selector}:`,
                        error,
                    )
                }
            }

            // Check for CAPTCHA images
            if (!captchaFound) {
                for (const selector of Object.values(
                    this.CAPTCHA_SELECTORS.image,
                )) {
                    try {
                        const element = await page.$(selector)
                        if (element) {
                            captchaFound = true
                            captchaType = 'image'
                            captchaSelector = selector
                            console.log(
                                `✅ [CAPTCHADetector] CAPTCHA image found with selector: ${selector}`,
                            )
                            break
                        }
                    } catch (error) {
                        console.log(
                            `⚠️ [CAPTCHADetector] Error checking image selector ${selector}:`,
                            error,
                        )
                    }
                }
            }

            // Check for CAPTCHA containers
            if (!captchaFound) {
                for (const selector of Object.values(
                    this.CAPTCHA_SELECTORS.popup,
                )) {
                    try {
                        const element = await page.$(selector)
                        if (element) {
                            const containerText = await element.textContent()
                            if (
                                containerText &&
                                CAPTCHALanguageDetector.containsCAPTCHAKeywords(
                                    containerText.toLowerCase(),
                                )
                            ) {
                                captchaFound = true
                                captchaType = 'text'
                                captchaSelector = selector
                                console.log(
                                    `✅ [CAPTCHADetector] CAPTCHA container found with selector: ${selector}`,
                                )
                                console.log(
                                    `📝 [CAPTCHADetector] Container text: ${containerText.substring(0, 100)}...`,
                                )
                                break
                            }
                        }
                    } catch (error) {
                        console.log(
                            `⚠️ [CAPTCHADetector] Error checking container selector ${selector}:`,
                            error,
                        )
                    }
                }
            }

            if (captchaFound) {
                console.log(
                    `🎯 [CAPTCHADetector] CAPTCHA detected! Type: ${captchaType}, Selector: ${captchaSelector}`,
                )
                return {
                    isPresent: true,
                    type: captchaType,
                    confidence: languageDetection.confidence,
                    location: { x: 0, y: 0, width: 1280, height: 720 }, // Placeholder, needs actual location
                    language: languageDetection,
                }
            } else {
                console.log(
                    '❌ [CAPTCHADetector] No CAPTCHA detected via HTML analysis',
                )

                // OCR the full screen to see what's actually visible
                console.log(
                    "🔍 [CAPTCHADetector] Performing full screen OCR to see what's visible...",
                )
                const fullScreenOCR = await this.captureAndOCRFullScreen(page)

                if (fullScreenOCR) {
                    console.log(
                        '📸 [CAPTCHADetector] Full screen OCR completed',
                    )
                    console.log(
                        '🔍 [CAPTCHADetector] What Tesseract sees on screen:',
                        fullScreenOCR.ocrResult,
                    )

                    // Log full screen OCR text systematically
                    console.log('📄 [CAPTCHADetector] Full screen OCR text:')
                    console.log('─'.repeat(50))
                    console.log(fullScreenOCR.ocrResult)
                    console.log('─'.repeat(50))

                    // Check if OCR found any CAPTCHA-like text
                    const ocrText = fullScreenOCR.ocrResult.toLowerCase()
                    const ocrHasKeywords =
                        CAPTCHALanguageDetector.containsCAPTCHAKeywords(ocrText)

                    if (ocrHasKeywords) {
                        console.log(
                            '🎯 [CAPTCHADetector] CAPTCHA detected via OCR!',
                        )
                        return {
                            isPresent: true,
                            type: 'text',
                            confidence: 0.8, // High confidence since OCR found it
                            location: { x: 0, y: 0, width: 1280, height: 720 },
                            language: languageDetection,
                            imagePath: fullScreenOCR.screenshotPath,
                        }
                    } else {
                        console.log(
                            '🔍 [CAPTCHADetector] No CAPTCHA keywords found in OCR text either',
                        )
                    }
                }

                return {
                    isPresent: false,
                    type: 'text',
                    confidence: 0,
                    location: { x: 0, y: 0, width: 0, height: 0 },
                    language: {
                        interfaceLanguage: 'unknown',
                        confidence: 0,
                        detectedKeywords: [],
                    },
                }
            }
        } catch (error) {
            console.error(
                '💥 [CAPTCHADetector] Error during CAPTCHA detection:',
                error,
            )
            return {
                isPresent: false,
                type: 'text',
                confidence: 0,
                location: { x: 0, y: 0, width: 0, height: 0 },
                language: {
                    interfaceLanguage: 'unknown',
                    confidence: 0,
                    detectedKeywords: [],
                },
            }
        }
    }

    /**
     * Check if page contains CAPTCHA-related text
     */
    private static async checkForCAPTCHAText(page: Page): Promise<boolean> {
        try {
            const pageText = await page.evaluate(() => {
                return {
                    bodyText: document.body.innerText,
                    titleText: document.title,
                    buttonTexts: Array.from(
                        document.querySelectorAll(
                            'button, input[type="submit"]',
                        ),
                    )
                        .map((el) => el.textContent || '')
                        .filter((text) => text.length > 0),
                }
            })

            const allText = [
                pageText.bodyText,
                pageText.titleText,
                ...pageText.buttonTexts,
            ].join(' ')

            return CAPTCHALanguageDetector.containsCAPTCHAKeywords(allText)
        } catch (error) {
            console.warn('Error checking CAPTCHA text:', error)
            return false
        }
    }

    /**
     * Find CAPTCHA-related UI elements
     */
    private static async findCAPTCHAElements(
        page: Page,
    ): Promise<CAPTCHAElement[]> {
        const elements: CAPTCHAElement[] = []

        try {
            // Check for popup dialogs
            for (const selector of this.CAPTCHA_SELECTORS.popup) {
                const popup = page.locator(selector)
                if ((await popup.count()) > 0) {
                    elements.push({
                        selector,
                        type: 'text',
                        attributes: { role: 'dialog' },
                    })
                }
            }

            // Check for CAPTCHA images
            for (const selector of this.CAPTCHA_SELECTORS.image) {
                const image = page.locator(selector)
                if ((await image.count()) > 0) {
                    elements.push({
                        selector,
                        type: 'image',
                        attributes: {
                            src: (await image.getAttribute('src')) || '',
                        },
                    })
                }
            }

            // Check for CAPTCHA input fields
            for (const selector of this.CAPTCHA_SELECTORS.input) {
                const input = page.locator(selector)
                if ((await input.count()) > 0) {
                    elements.push({
                        selector,
                        type: 'input',
                        attributes: {
                            placeholder:
                                (await input.getAttribute('placeholder')) || '',
                            name: (await input.getAttribute('name')) || '',
                        },
                    })
                }
            }

            // Check for CAPTCHA buttons
            for (const selector of this.CAPTCHA_SELECTORS.buttons) {
                const button = page.locator(selector)
                if ((await button.count()) > 0) {
                    elements.push({
                        selector,
                        type: 'button',
                        attributes: {
                            text: (await button.textContent()) || '',
                        },
                    })
                }
            }
        } catch (error) {
            console.warn('Error finding CAPTCHA elements:', error)
        }

        return elements
    }

    /**
     * Determine CAPTCHA type and location
     */
    private static async determineCAPTCHATypeAndLocation(
        page: Page,
        elements: CAPTCHAElement[],
    ): Promise<{
        type: 'text' | 'image' | 'audio'
        location: { x: number; y: number; width: number; height: number }
    }> {
        // Default to text CAPTCHA
        let type: 'text' | 'image' | 'audio' = 'text'
        let location = { x: 0, y: 0, width: 1280, height: 720 }

        try {
            // Look for CAPTCHA image first
            const imageElement = elements.find((el) => el.type === 'image')
            if (imageElement) {
                type = 'image'
                const image = page.locator(imageElement.selector)
                const box = await image.boundingBox()
                if (box) {
                    location = {
                        x: box.x,
                        y: box.y,
                        width: box.width,
                        height: box.height,
                    }
                }
            } else {
                // Look for popup dialog
                const popupElement = elements.find((el) => el.type === 'text')
                if (popupElement) {
                    const popup = page.locator(popupElement.selector)
                    const box = await popup.boundingBox()
                    if (box) {
                        location = {
                            x: box.x,
                            y: box.y,
                            width: box.width,
                            height: box.height,
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Error determining CAPTCHA type and location:', error)
        }

        return { type, location }
    }

    /**
     * Capture and OCR the entire screen to see what's visible
     */
    public static async captureAndOCRFullScreen(page: Page): Promise<{
        screenshotPath: string
        ocrResult: string
        ocrDetails: any
    } | null> {
        console.log(
            '📸 [CAPTCHADetector] Capturing full screen for OCR analysis...',
        )

        try {
            const timestamp = Date.now()
            const screenshotsPath =
                PathManager.getInstance().getScreenshotsPath()
            const imagePath = path.join(
                screenshotsPath,
                `${timestamp}_captcha_fullscreen.png`,
            )

            // Ensure screenshots directory exists
            if (!fs.existsSync(screenshotsPath)) {
                fs.mkdirSync(screenshotsPath, { recursive: true })
            }

            // Capture full page screenshot
            await page.screenshot({
                path: imagePath,
                fullPage: true,
            })

            console.log(
                `📸 [CAPTCHADetector] Full screen captured: ${imagePath}`,
            )

            // OCR the full screen
            const { CAPTCHASolver } = await import('./CAPTCHASolver')
            const solver = new CAPTCHASolver()
            await solver.initialize()

            const ocrResult = await solver.solveTextCAPTCHA(imagePath)

            console.log(
                '🔍 [CAPTCHADetector] Full screen OCR result:',
                ocrResult,
            )

            // Log temp file paths for visual inspection
            if (ocrResult.tempFiles) {
                console.log(
                    '💾 [CAPTCHADetector] Temp files saved for inspection:',
                )
                console.log(
                    '   📸 Original screenshot:',
                    ocrResult.tempFiles.original,
                )
                console.log(
                    '   🛠️ Preprocessed image:',
                    ocrResult.tempFiles.preprocessed,
                )
                console.log(
                    '   📁 Temp directory:',
                    ocrResult.tempFiles.tempDir,
                )

                // Save CAPTCHA detection metadata
                await this.saveCAPTCHAMetadata(ocrResult, {
                    screenshotPath: imagePath,
                    ocrResult: ocrResult.text,
                    ocrDetails: ocrResult,
                })
            }

            // Properly terminate the solver to avoid memory leaks
            await solver.terminate()
            console.log('🛑 [CAPTCHADetector] Tesseract worker terminated')

            // Note: Temp files are preserved for inspection (cleanup disabled)
            console.log(
                '💾 [CAPTCHADetector] Temp files preserved for visual inspection',
            )

            return {
                screenshotPath: imagePath,
                ocrResult: ocrResult.text,
                ocrDetails: ocrResult,
            }
        } catch (error) {
            console.error(
                '❌ [CAPTCHADetector] Error capturing/OCR full screen:',
                error,
            )
            return null
        }
    }

    /**
     * Capture CAPTCHA image
     */
    public static async captureCAPTCHAImage(
        page: Page,
        detection: CAPTCHADetection,
    ): Promise<string | null> {
        console.log('📸 [CAPTCHADetector] Starting CAPTCHA image capture...')

        if (!detection.isPresent) {
            console.log(
                '❌ [CAPTCHADetector] No CAPTCHA detected, skipping image capture',
            )
            return null
        }

        try {
            const timestamp = Date.now()
            const screenshotsPath =
                PathManager.getInstance().getScreenshotsPath()
            const imagePath = path.join(
                screenshotsPath,
                `captcha_${timestamp}.png`,
            )

            // Ensure screenshots directory exists
            if (!fs.existsSync(screenshotsPath)) {
                fs.mkdirSync(screenshotsPath, { recursive: true })
            }

            if (
                detection.type === 'image' &&
                detection.location.width > 0 &&
                detection.location.height > 0
            ) {
                // Capture specific CAPTCHA image area
                await page.screenshot({
                    path: imagePath,
                    clip: detection.location,
                })
            } else {
                // Capture entire page if specific location not found
                await page.screenshot({
                    path: imagePath,
                })
            }

            console.log(
                `📸 [CAPTCHADetector] CAPTCHA image captured: ${imagePath}`,
            )
            return imagePath
        } catch (error) {
            console.error('❌ Error capturing CAPTCHA image:', error)
            return null
        }
    }

    /**
     * Calculate confidence score based on detection factors
     */
    private static calculateConfidence(
        hasText: boolean,
        elementCount: number,
        languageConfidence: number,
    ): number {
        let confidence = 0

        if (hasText) confidence += 0.4
        if (elementCount > 0) confidence += Math.min(elementCount * 0.2, 0.4)
        confidence += languageConfidence * 0.2

        return Math.min(confidence, 1.0)
    }

    /**
     * Find CAPTCHA input field
     */
    public static async findCAPTCHAInput(
        page: Page,
    ): Promise<{ selector: string; found: boolean }> {
        for (const selector of this.CAPTCHA_SELECTORS.input) {
            const input = page.locator(selector)
            if ((await input.count()) > 0) {
                return { selector, found: true }
            }
        }
        return { selector: '', found: false }
    }

    /**
     * Find CAPTCHA submit button
     */
    public static async findCAPTCHASubmitButton(
        page: Page,
    ): Promise<{ selector: string; found: boolean }> {
        for (const selector of this.CAPTCHA_SELECTORS.buttons) {
            const button = page.locator(selector)
            if ((await button.count()) > 0) {
                return { selector, found: true }
            }
        }
        return { selector: '', found: false }
    }

    /**
     * Save CAPTCHA detection metadata to a log file
     */
    private static async saveCAPTCHAMetadata(
        ocrResult: any,
        fullScreenOCR: {
            screenshotPath: string
            ocrResult: string
            ocrDetails: any
        },
    ): Promise<void> {
        try {
            const pathManager = PathManager.getInstance()
            const metadataPath = path.join(
                pathManager.getBasePath(),
                'captcha_detection.log',
            )
            const ocrResultsPath = path.join(
                pathManager.getBasePath(),
                'ocr_results.log',
            )

            const metadata = {
                timestamp: new Date().toISOString(),
                botUuid: pathManager.getIdentifier(),
                detection: {
                    success: ocrResult.success,
                    text: ocrResult.text,
                    confidence: ocrResult.confidence,
                    originalText: ocrResult.originalText,
                    tempFiles: ocrResult.tempFiles,
                },
                fullScreenOCR: {
                    screenshotPath: fullScreenOCR.screenshotPath,
                    ocrResult: fullScreenOCR.ocrResult,
                },
            }

            const logEntry = JSON.stringify(metadata, null, 2) + '\n---\n'
            await fs.promises.appendFile(metadataPath, logEntry)
            console.log(
                '📝 [CAPTCHADetector] CAPTCHA metadata saved to:',
                metadataPath,
            )

            // Save detailed OCR results to separate log
            const ocrLogEntry = {
                timestamp: new Date().toISOString(),
                botUuid: pathManager.getIdentifier(),
                screenshotPath: fullScreenOCR.screenshotPath,
                rawOCR: ocrResult.originalText,
                cleanedText: ocrResult.text,
                confidence: ocrResult.confidence,
                tempFiles: ocrResult.tempFiles,
                detectedWords: ocrResult.ocrDetails?.words || [],
                detectedLines: ocrResult.ocrDetails?.lines || [],
                detectedSymbols: ocrResult.ocrDetails?.symbols || [],
            }

            const ocrLogString =
                JSON.stringify(ocrLogEntry, null, 2) + '\n---\n'
            await fs.promises.appendFile(ocrResultsPath, ocrLogString)
            console.log(
                '📝 [CAPTCHADetector] Detailed OCR results saved to:',
                ocrResultsPath,
            )
        } catch (error) {
            console.warn(
                '⚠️ [CAPTCHADetector] Failed to save CAPTCHA metadata:',
                error,
            )
        }
    }

    /**
     * Use existing FFmpeg screenshots for CAPTCHA detection
     * This is more efficient than taking separate Playwright screenshots
     */
    public static async detectCAPTCHAFromScreenshots(
        screenshotsPath: string,
        maxAgeMs: number = 60000, // Look for screenshots from last 60 seconds (accounting for startup delay + join process)
    ): Promise<CAPTCHADetection[]> {
        console.log(
            `🔍 [CAPTCHADetector] Detecting CAPTCHA from existing screenshots...`,
        )
        console.log(`📁 [CAPTCHADetector] Searching in: ${screenshotsPath}`)
        console.log(
            `⏰ [CAPTCHADetector] Max age: ${maxAgeMs}ms (${Math.round(maxAgeMs / 1000)}s)`,
        )

        try {
            if (!fs.existsSync(screenshotsPath)) {
                console.log(
                    '📁 [CAPTCHADetector] Screenshots directory not found',
                )
                return []
            }

            const files = fs.readdirSync(screenshotsPath)
            console.log(
                `📁 [CAPTCHADetector] Found ${files.length} total files in directory`,
            )

            const pngFiles = files.filter((file) => file.endsWith('.png'))
            console.log(
                `📸 [CAPTCHADetector] Found ${pngFiles.length} PNG files`,
            )

            const screenshotFiles = pngFiles
                .map((file) => {
                    const timestamp = this.extractTimestampFromFilename(file)
                    const age = Date.now() - timestamp
                    const isValid = age <= maxAgeMs && age >= 0

                    console.log(`📸 [CAPTCHADetector] Processing file: ${file}`)
                    console.log(
                        `📸 [CAPTCHADetector]   - Extracted timestamp: ${timestamp}`,
                    )
                    console.log(
                        `📸 [CAPTCHADetector]   - Current time: ${Date.now()}`,
                    )
                    console.log(
                        `📸 [CAPTCHADetector]   - Age: ${age}ms (${Math.round(age / 1000)}s)`,
                    )
                    console.log(
                        `📸 [CAPTCHADetector]   - Max age: ${maxAgeMs}ms (${Math.round(maxAgeMs / 1000)}s)`,
                    )
                    console.log(`📸 [CAPTCHADetector]   - Valid: ${isValid}`)

                    return {
                        name: file,
                        path: path.join(screenshotsPath, file),
                        timestamp: timestamp,
                        age: age,
                        isValid: isValid,
                    }
                })
                .filter((file) => file.isValid)
                .sort((a, b) => b.timestamp - a.timestamp) // Most recent first

            console.log(
                `📸 [CAPTCHADetector] Found ${screenshotFiles.length} recent screenshots (maxAge: ${maxAgeMs}ms)`,
            )

            // If no screenshots found, wait a bit and try again (screenshots take ~9.5s to start + join process time)
            if (screenshotFiles.length === 0) {
                console.log(
                    '⏳ [CAPTCHADetector] No screenshots found, waiting for first screenshot (startup delay ~9.5s + join process)...',
                )
                await new Promise((resolve) => setTimeout(resolve, 10000)) // Wait 10 seconds

                // Try again with a longer window to account for startup delay + join process
                const retryFiles = fs
                    .readdirSync(screenshotsPath)
                    .filter((file) => file.endsWith('.png'))
                    .map((file) => {
                        const timestamp =
                            this.extractTimestampFromFilename(file)
                        const age = Date.now() - timestamp
                        const isValid = age <= 45000 && age >= 0 // 45 second window for retry

                        console.log(
                            `📸 [CAPTCHADetector] RETRY Processing file: ${file}`,
                        )
                        console.log(
                            `📸 [CAPTCHADetector]   - Extracted timestamp: ${timestamp}`,
                        )
                        console.log(
                            `📸 [CAPTCHADetector]   - Current time: ${Date.now()}`,
                        )
                        console.log(
                            `📸 [CAPTCHADetector]   - Age: ${age}ms (${Math.round(age / 1000)}s)`,
                        )
                        console.log(
                            `📸 [CAPTCHADetector]   - Max age: 45000ms (45s)`,
                        )
                        console.log(
                            `📸 [CAPTCHADetector]   - Valid: ${isValid}`,
                        )

                        return {
                            name: file,
                            path: path.join(screenshotsPath, file),
                            timestamp: timestamp,
                            age: age,
                            isValid: isValid,
                        }
                    })
                    .filter((file) => file.isValid)
                    .sort((a, b) => b.timestamp - a.timestamp)

                console.log(
                    `📸 [CAPTCHADetector] Retry found ${retryFiles.length} screenshots`,
                )
                screenshotFiles.push(...retryFiles)
            }

            const detections: CAPTCHADetection[] = []

            for (const screenshot of screenshotFiles) {
                const age = Date.now() - screenshot.timestamp
                console.log(
                    `🔍 [CAPTCHADetector] Analyzing screenshot: ${screenshot.name} (age: ${Math.round(age / 1000)}s)`,
                )

                const detection = await this.analyzeScreenshotForCAPTCHA(
                    screenshot.path,
                )
                if (detection.isPresent) {
                    console.log(
                        `🎯 [CAPTCHADetector] CAPTCHA detected in ${screenshot.name}`,
                    )
                    detections.push({
                        ...detection,
                        screenshotPath: screenshot.path,
                        timestamp: screenshot.timestamp,
                    })
                }
            }

            return detections
        } catch (error) {
            console.error(
                '❌ [CAPTCHADetector] Error detecting CAPTCHA from screenshots:',
                error,
            )
            return []
        }
    }

    /**
     * Extract timestamp from screenshot filename
     */
    private static extractTimestampFromFilename(filename: string): number {
        console.log(
            `🔍 [CAPTCHADetector] Extracting timestamp from: ${filename}`,
        )

        // Handle patterns like: 1753230880859_0001.png
        const match = filename.match(/^(\d+)_\d+\.png$/)
        if (match) {
            const timestamp = parseInt(match[1], 10)
            console.log(
                `🔍 [CAPTCHADetector]   - Pattern 1 match: ${timestamp}`,
            )
            return timestamp
        }

        // Fallback: try to extract any number sequence
        const numberMatch = filename.match(/(\d{10,})/)
        if (numberMatch) {
            const timestamp = parseInt(numberMatch[1], 10)
            console.log(
                `🔍 [CAPTCHADetector]   - Pattern 2 match: ${timestamp}`,
            )
            return timestamp
        }

        console.log(
            `🔍 [CAPTCHADetector]   - No pattern match, using current time: ${Date.now()}`,
        )
        return Date.now() // Fallback to current time
    }

    /**
     * Analyze a screenshot file for CAPTCHA presence
     * ALWAYS logs OCR results from images (philosophy: complete visibility)
     */
    private static async analyzeScreenshotForCAPTCHA(
        imagePath: string,
    ): Promise<CAPTCHADetection> {
        try {
            console.log(
                `🔍 [CAPTCHADetector] 🔍 ANALYZING SCREENSHOT: ${imagePath}`,
            )

            // Use the existing CAPTCHA solver to analyze the image
            const solver = new CAPTCHASolver()
            await solver.initialize()

            // ALWAYS perform OCR and log results (philosophy: complete visibility)
            const result = await solver.solveTextCAPTCHA(imagePath)

            // Check if the OCR result contains CAPTCHA-related text
            const hasCAPTCHAText = this.containsCAPTCHAText(
                result.originalText || '',
            )

            // Log the analysis result
            console.log(
                `📊 [CAPTCHADetector] 📊 ANALYSIS RESULT for ${imagePath}:`,
            )
            console.log(`   - CAPTCHA detected: ${hasCAPTCHAText}`)
            console.log(`   - Confidence: ${result.confidence}`)
            console.log(
                `   - Text length: ${(result.originalText || '').length} chars`,
            )

            // ALWAYS save OCR results to files (philosophy: persistent storage)
            try {
                await this.saveCAPTCHAMetadata(result, {
                    screenshotPath: imagePath,
                    ocrResult: result.originalText || '',
                    ocrDetails: {}, // OCR details are logged separately in CAPTCHASolver
                })
                console.log(
                    `💾 [CAPTCHADetector] OCR results saved to files for: ${imagePath}`,
                )
            } catch (saveError) {
                console.warn(
                    `⚠️ [CAPTCHADetector] Failed to save OCR results for ${imagePath}:`,
                    saveError,
                )
            }

            return {
                isPresent: hasCAPTCHAText,
                type: hasCAPTCHAText ? 'text' : 'image',
                confidence: result.confidence,
                location: { x: 0, y: 0, width: 0, height: 0 }, // Full image
                language: {
                    interfaceLanguage: 'en',
                    confidence: 0.8,
                    detectedKeywords: [],
                },
                screenshotPath: imagePath,
            }
        } catch (error) {
            console.error(
                `❌ [CAPTCHADetector] Error analyzing screenshot ${imagePath}:`,
                error,
            )
            return {
                isPresent: false,
                type: 'image',
                confidence: 0,
                location: { x: 0, y: 0, width: 0, height: 0 },
                language: {
                    interfaceLanguage: 'en',
                    confidence: 0,
                    detectedKeywords: [],
                },
            }
        }
    }

    /**
     * Check if text contains CAPTCHA-related content
     */
    private static containsCAPTCHAText(text: string): boolean {
        const captchaKeywords = [
            'verify',
            'robot',
            'captcha',
            'human',
            'person',
            'vérifiez',
            'robot',
            'captcha',
            'humain',
            'personne',
            'verificar',
            'robot',
            'captcha',
            'humano',
            'überprüfen',
            'roboter',
            'captcha',
            'mensch',
        ]

        const lowerText = text.toLowerCase()
        return captchaKeywords.some((keyword) => lowerText.includes(keyword))
    }
}
