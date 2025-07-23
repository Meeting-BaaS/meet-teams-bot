import { Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { LanguageDetection } from './CAPTCHALanguageDetector'
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
     * Use existing FFmpeg screenshots for CAPTCHA detection
     * This is more efficient than taking separate Playwright screenshots
     */
    public static async detectCAPTCHAFromScreenshots(
        screenshotsPath: string,
        maxAgeMs: number = 60000, // Look for screenshots from last 60 seconds
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

            // If no screenshots found, wait a bit and try again
            if (screenshotFiles.length === 0) {
                console.log(
                    '⏳ [CAPTCHADetector] No screenshots found, waiting for first screenshot...',
                )
                await new Promise((resolve) => setTimeout(resolve, 10000)) // Wait 10 seconds

                // Try again with a longer window
                const retryFiles = fs
                    .readdirSync(screenshotsPath)
                    .filter((file) => file.endsWith('.png'))
                    .map((file) => {
                        const timestamp =
                            this.extractTimestampFromFilename(file)
                        const age = Date.now() - timestamp
                        const isValid = age <= 45000 && age >= 0 // 45 second window for retry

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
}
