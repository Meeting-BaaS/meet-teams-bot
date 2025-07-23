import { Page } from '@playwright/test'
import { CAPTCHA_CONSTANTS, OCR_CONSTANTS } from '../state-machine/constants'
import { CAPTCHAConfig, CAPTCHAHandlingResult } from '../types'
import { CAPTCHADetection, CAPTCHADetector } from './CAPTCHADetector'
import { CAPTCHASolver } from './CAPTCHASolver'
import { PathManager } from './PathManager'
import { sleep } from './sleep'

export class CAPTCHAHandler {
    private solver: CAPTCHASolver
    private config: CAPTCHAConfig
    private static isInCleanup: boolean = false

    constructor(config: Partial<CAPTCHAConfig> = {}) {
        this.solver = new CAPTCHASolver()
        this.config = {
            enabled: true,
            maxAttempts: CAPTCHA_CONSTANTS.DEFAULT_MAX_ATTEMPTS,
            timeoutMs: CAPTCHA_CONSTANTS.DEFAULT_TIMEOUT_MS,
            confidenceThreshold: CAPTCHA_CONSTANTS.DEFAULT_CONFIDENCE_THRESHOLD,
            languages: [...CAPTCHA_CONSTANTS.SUPPORTED_LANGUAGES],
            retryDelayMs: CAPTCHA_CONSTANTS.DEFAULT_RETRY_DELAY_MS,
            ...config,
        }
    }

    /**
     * Main method to handle CAPTCHA challenges
     */
    public async handleCAPTCHA(
        page: Page,
        currentState?: string,
    ): Promise<CAPTCHAHandlingResult> {
        // Check if we're in cleanup mode - if so, skip CAPTCHA detection
        if (
            CAPTCHAHandler.isInCleanup ||
            currentState === 'cleanup' ||
            currentState === 'terminated'
        ) {
            // Reduced verbosity for cleanup state
            return { success: true, attempts: 0, language: 'en' }
        }

        console.log('🎯 [CAPTCHAHandler] Starting CAPTCHA handling process...')

        const startTime = Date.now()
        let attempts = 0

        try {
            while (attempts < this.config.maxAttempts) {
                attempts++
                console.log(
                    `🔄 [CAPTCHAHandler] Attempt ${attempts}/${this.config.maxAttempts}`,
                )

                // Detect CAPTCHA using existing screenshots (more efficient)
                console.log(
                    '🔍 [CAPTCHAHandler] Detecting CAPTCHA from existing screenshots...',
                )
                const screenshotsPath =
                    PathManager.getInstance().getScreenshotsPath()
                const detections =
                    await CAPTCHADetector.detectCAPTCHAFromScreenshots(
                        screenshotsPath,
                        300000, // 5 minute window
                        true, // Process all screenshots for complete visibility
                    )

                // Use the most recent detection if any found
                const detection: CAPTCHADetection =
                    detections.length > 0
                        ? detections[0]
                        : {
                              isPresent: false,
                              type: 'image' as const,
                              confidence: 0,
                              location: { x: 0, y: 0, width: 0, height: 0 },
                              language: {
                                  interfaceLanguage: 'en',
                                  confidence: 0,
                                  detectedKeywords: [],
                              },
                          }

                if (!detection.isPresent) {
                    console.log(
                        '✅ [CAPTCHAHandler] No CAPTCHA detected, handling complete',
                    )
                    return {
                        success: true,
                        attempts,
                        language: 'en',
                    }
                }

                console.log(
                    `🎯 [CAPTCHAHandler] CAPTCHA detected! Type: ${detection.type}, Language: ${detection.language.interfaceLanguage}`,
                )

                // Handle based on type
                if (detection.type === 'text') {
                    console.log(
                        '📝 [CAPTCHAHandler] Handling text-based CAPTCHA...',
                    )
                    const result = await this.handleTextCAPTCHA(page, detection)

                    if (result.success) {
                        console.log(
                            `✅ [CAPTCHAHandler] Text CAPTCHA handled successfully in ${attempts} attempts`,
                        )
                        return result
                    } else {
                        console.log(
                            `❌ [CAPTCHAHandler] Text CAPTCHA handling failed: ${result.error}`,
                        )
                    }
                } else if (detection.type === 'image') {
                    console.log(
                        '🖼️ [CAPTCHAHandler] Image CAPTCHA detected - not yet implemented',
                    )
                    return {
                        success: false,
                        attempts,
                        error: 'Image CAPTCHA not yet supported',
                        language: detection.language.interfaceLanguage,
                    }
                } else {
                    console.log('❓ [CAPTCHAHandler] Unknown CAPTCHA type')
                    return {
                        success: false,
                        attempts,
                        error: 'Unknown CAPTCHA type',
                        language: detection.language.interfaceLanguage,
                    }
                }

                // Wait before retry
                if (attempts < this.config.maxAttempts) {
                    console.log(
                        `⏳ [CAPTCHAHandler] Waiting ${this.config.retryDelayMs}ms before retry...`,
                    )
                    await sleep(this.config.retryDelayMs)
                }
            }

            const totalTime = Date.now() - startTime
            console.log(
                `💥 [CAPTCHAHandler] All attempts failed after ${totalTime}ms`,
            )

            return {
                success: false,
                attempts,
                error: `Failed after ${attempts} attempts`,
                language: 'en',
            }
        } catch (error) {
            console.error(
                '💥 [CAPTCHAHandler] Unexpected error during CAPTCHA handling:',
                error,
            )
            return {
                success: false,
                attempts,
                error: error instanceof Error ? error.message : 'Unknown error',
                language: 'en',
            }
        }
    }

    /**
     * Continuous OCR analysis throughout the entire meeting
     * This runs continuously regardless of CAPTCHA presence
     */
    public async performContinuousOCR(
        page: Page,
        currentState?: string,
    ): Promise<void> {
        // Check if we're in cleanup mode - if so, skip OCR
        if (
            CAPTCHAHandler.isInCleanup ||
            currentState === 'cleanup' ||
            currentState === 'terminated'
        ) {
            return
        }

        console.log('📊 [CAPTCHAHandler] Performing continuous OCR analysis...')

        try {
            const screenshotsPath =
                PathManager.getInstance().getScreenshotsPath()

            // Process all recent screenshots for continuous OCR
            await CAPTCHADetector.detectCAPTCHAFromScreenshots(
                screenshotsPath,
                OCR_CONSTANTS.DEFAULT_SCREENSHOT_MAX_AGE_MS, // Use shorter window for continuous processing
                true, // Process all screenshots for complete visibility
            )

            console.log('📊 [CAPTCHAHandler] Continuous OCR analysis completed')
        } catch (error) {
            console.error(
                '💥 [CAPTCHAHandler] Error during continuous OCR:',
                error,
            )
        }
    }

    private async handleTextCAPTCHA(
        page: Page,
        detection: CAPTCHADetection,
    ): Promise<CAPTCHAHandlingResult> {
        console.log('📝 [CAPTCHAHandler] Starting text CAPTCHA handling...')

        try {
            // Use existing screenshot from detection (more efficient)
            console.log(
                '📸 [CAPTCHAHandler] Using existing screenshot for CAPTCHA solving...',
            )
            const imagePath = detection.screenshotPath

            if (!imagePath) {
                console.error(
                    '❌ [CAPTCHAHandler] No screenshot path available in detection',
                )
                return {
                    success: false,
                    attempts: 1,
                    error: 'No screenshot path available',
                    language: detection.language.interfaceLanguage,
                }
            }

            console.log(
                `✅ [CAPTCHAHandler] CAPTCHA image captured: ${imagePath}`,
            )

            // Solve CAPTCHA using OCR
            console.log('🔍 [CAPTCHAHandler] Solving CAPTCHA with OCR...')
            const solution = await this.solver.solveTextCAPTCHA(imagePath)

            if (!solution.success) {
                console.error(
                    `❌ [CAPTCHAHandler] OCR failed: ${solution.error}`,
                )
                return {
                    success: false,
                    attempts: 1,
                    error: `OCR failed: ${solution.error}`,
                    language: detection.language.interfaceLanguage,
                }
            }

            console.log(
                `✅ [CAPTCHAHandler] OCR solution: "${solution.text}" (confidence: ${solution.confidence})`,
            )

            // Submit the solution
            console.log('📤 [CAPTCHAHandler] Submitting CAPTCHA solution...')
            const submitResult = await this.submitCAPTCHASolution(
                page,
                solution.text,
                detection.language.interfaceLanguage,
            )

            if (!submitResult.success) {
                console.error(
                    `❌ [CAPTCHAHandler] Solution submission failed: ${submitResult.error}`,
                )
                return {
                    success: false,
                    attempts: 1,
                    error: `Submission failed: ${submitResult.error}`,
                    language: detection.language.interfaceLanguage,
                }
            }

            console.log('✅ [CAPTCHAHandler] Solution submitted successfully')

            // Check if solution was accepted
            console.log(
                '🔍 [CAPTCHAHandler] Checking if solution was accepted...',
            )
            const accepted = await this.checkCAPTCHASolutionAccepted(page)

            if (accepted) {
                console.log('✅ [CAPTCHAHandler] CAPTCHA solution accepted!')
                return {
                    success: true,
                    attempts: 1,
                    solution: solution.text,
                    language: detection.language.interfaceLanguage,
                }
            } else {
                console.log(
                    '❌ [CAPTCHAHandler] CAPTCHA solution was not accepted',
                )
                return {
                    success: false,
                    attempts: 1,
                    error: 'Solution not accepted',
                    language: detection.language.interfaceLanguage,
                }
            }
        } catch (error) {
            console.error(
                '💥 [CAPTCHAHandler] Error during text CAPTCHA handling:',
                error,
            )
            return {
                success: false,
                attempts: 1,
                error: error instanceof Error ? error.message : 'Unknown error',
                language: detection.language.interfaceLanguage,
            }
        }
    }

    /**
     * Submit CAPTCHA solution
     */
    private async submitCAPTCHASolution(
        page: Page,
        solution: string,
        language: string,
    ): Promise<CAPTCHAHandlingResult> {
        try {
            // Find input field
            const inputResult = await CAPTCHADetector.findCAPTCHAInput(page)
            if (!inputResult.found) {
                console.warn('⚠️ CAPTCHA input field not found')
                return {
                    success: false,
                    attempts: 1,
                    error: 'CAPTCHA input field not found',
                }
            }

            // Find submit button
            const buttonResult =
                await CAPTCHADetector.findCAPTCHASubmitButton(page)
            if (!buttonResult.found) {
                console.warn('⚠️ CAPTCHA submit button not found')
                return {
                    success: false,
                    attempts: 1,
                    error: 'CAPTCHA submit button not found',
                }
            }

            // Fill input field
            const input = page.locator(inputResult.selector)
            await input.clear()
            await input.fill(solution)
            console.log(`📝 Filled CAPTCHA input: "${solution}"`)

            // Click submit button
            const submitButton = page.locator(buttonResult.selector)
            await submitButton.click()
            console.log('🖱️ Clicked CAPTCHA submit button')

            return { success: true, attempts: 1 }
        } catch (error) {
            console.error('❌ Error submitting CAPTCHA solution:', error)
            return {
                success: false,
                attempts: 1,
                error: error instanceof Error ? error.message : 'Unknown error',
            }
        }
    }

    /**
     * Check if CAPTCHA solution was accepted
     */
    private async checkCAPTCHASolutionAccepted(page: Page): Promise<boolean> {
        try {
            // Check if CAPTCHA dialog is still present
            const detection =
                await CAPTCHADetector.detectCAPTCHAFromScreenshots(
                    PathManager.getInstance().getScreenshotsPath(),
                )

            if (detection.length === 0) {
                return true // CAPTCHA dialog disappeared, likely accepted
            }

            // Check for error messages
            const errorSelectors = [
                'text=incorrect',
                'text=wrong',
                'text=incorrecte',
                'text=incorrecto',
                'text=falsch',
                'text=error',
                'text=erreur',
                'text=error',
                'text=fehler',
            ]

            for (const selector of errorSelectors) {
                const errorElement = page.locator(selector)
                if ((await errorElement.count()) > 0) {
                    console.log(`❌ Error message found: ${selector}`)
                    return false
                }
            }

            // If no error messages and CAPTCHA is still present, assume it's a new CAPTCHA
            return false
        } catch (error) {
            console.warn(
                '⚠️ Error checking CAPTCHA solution acceptance:',
                error,
            )
            return false
        }
    }

    /**
     * Set cleanup mode to prevent CAPTCHA detection during shutdown
     */
    public static setCleanupMode(enabled: boolean): void {
        CAPTCHAHandler.isInCleanup = enabled
        console.log(
            `🛑 [CAPTCHAHandler] Cleanup mode ${enabled ? 'enabled' : 'disabled'}`,
        )
    }

    /**
     * Check if cleanup mode is active
     */
    public static isCleanupMode(): boolean {
        return CAPTCHAHandler.isInCleanup
    }
}
