import * as fs from 'fs'
import * as path from 'path'
import Tesseract from 'tesseract.js'
import { promisify } from 'util'
import { CAPTCHA_CONSTANTS } from '../state-machine/constants'
import { PathManager } from './PathManager'

const exec = promisify(require('child_process').exec)

export interface CAPTCHASolution {
    success: boolean
    text: string
    confidence: number
    error?: string
    originalText?: string
    preprocessedImagePath?: string
    tempFiles?: {
        original: string
        preprocessed: string
        tempDir: string
    }
    ocrDetails?: {
        words: Array<{
            text: string
            confidence: number
            bbox: { x0: number; y0: number; x1: number; y1: number }
        }>
        lines: Array<{
            text: string
            confidence: number
            bbox: { x0: number; y0: number; x1: number; y1: number }
        }>
        symbols: Array<{
            text: string
            confidence: number
            bbox: { x0: number; y0: number; x1: number; y1: number }
        }>
    }
}

export interface PreprocessingConfig {
    crop?: { x: number; y: number; width: number; height: number }
    scale?: number
    contrast?: number
    brightness?: number
    threshold?: number
    unsharp?: string
    noiseReduction?: boolean
    binarization?: boolean
    deskew?: boolean
    sharpen?: boolean
}

export class CAPTCHASolver {
    private worker: any = null
    private isInitialized: boolean = false
    private readonly tempDir: string

    constructor() {
        this.tempDir = PathManager.getInstance().getTempPath()
    }

    /**
     * Initialize Tesseract.js worker with multi-language support
     */
    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            console.log('✅ [CAPTCHASolver] Already initialized')
            return
        }

        console.log('🔧 [CAPTCHASolver] Initializing Tesseract.js worker...')

        try {
            this.worker = await Tesseract.createWorker([
                'eng',
                'fra',
                'spa',
                'deu',
            ])
            console.log(
                '✅ [CAPTCHASolver] Tesseract worker created successfully',
            )

            await this.worker.setParameters({
                tessedit_char_whitelist:
                    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz.,!?\'"()-:;',
                tessedit_pageseg_mode: Tesseract.PSM.AUTO,
                tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
                preserve_interword_spaces: '1',
                tessedit_do_invert: '0',
                textord_heavy_nr: '1',
                textord_min_linesize: '2.5',
                tessedit_min_confidence: '30',
                tessedit_char_blacklist: '|_[]{}<>',
                user_defined_dpi: '300',
                tessedit_write_images: '0',
                debug_file: '/dev/null',
            })
            console.log('✅ [CAPTCHASolver] Tesseract parameters configured')

            this.isInitialized = true
            console.log(
                '✅ [CAPTCHASolver] Initialization completed successfully',
            )
        } catch (error) {
            console.error('💥 [CAPTCHASolver] Initialization failed:', error)
            throw error
        }
    }

    /**
     * Solve text-based CAPTCHA using OCR
     */
    public async solveTextCAPTCHA(imagePath: string): Promise<CAPTCHASolution> {
        console.log(
            `🔍 [CAPTCHASolver] Starting CAPTCHA solving for: ${imagePath}`,
        )

        if (!this.isInitialized) {
            console.log(
                '🔧 [CAPTCHASolver] Worker not initialized, initializing now...',
            )
            await this.initialize()
        }

        try {
            // Verify image file exists
            if (!fs.existsSync(imagePath)) {
                console.error(
                    `❌ [CAPTCHASolver] Image file not found: ${imagePath}`,
                )
                return {
                    success: false,
                    text: '',
                    confidence: 0,
                    error: 'Image file not found',
                    ocrDetails: {
                        words: [],
                        lines: [],
                        symbols: [],
                    },
                }
            }

            const stats = fs.statSync(imagePath)
            console.log(
                `📸 [CAPTCHASolver] Image file size: ${stats.size} bytes`,
            )

            // Preprocess the image
            console.log('🛠️ [CAPTCHASolver] Starting image preprocessing...')
            const preprocessedPath = await this.preprocessImage(imagePath, {
                crop: { x: 0, y: 0, width: 0, height: 0 },
                scale: CAPTCHA_CONSTANTS.DEFAULT_SCALE_FACTOR,
                contrast: CAPTCHA_CONSTANTS.DEFAULT_CONTRAST,
                brightness: CAPTCHA_CONSTANTS.DEFAULT_BRIGHTNESS,
                noiseReduction: false, // Disable noise reduction
                binarization: false, // Disable for better text recognition
                deskew: false, // Disable deskew
                sharpen: false, // Disable sharpening initially
            })

            if (!preprocessedPath) {
                console.error('❌ [CAPTCHASolver] Image preprocessing failed')
                return {
                    success: false,
                    text: '',
                    confidence: 0,
                    error: 'Image preprocessing failed',
                    ocrDetails: {
                        words: [],
                        lines: [],
                        symbols: [],
                    },
                }
            }

            console.log(
                `✅ [CAPTCHASolver] Image preprocessed: ${preprocessedPath}`,
            )

            // Perform OCR
            console.log('🔍 [CAPTCHASolver] Starting OCR analysis...')
            const result = await this.worker.recognize(preprocessedPath)

            console.log(
                `📝 [CAPTCHASolver] Raw OCR result: "${result.data.text}" (confidence: ${result.data.confidence})`,
            )

            // Log full OCR text systematically
            console.log('📄 [CAPTCHASolver] Full OCR text:')
            console.log('─'.repeat(50))
            console.log(result.data.text)
            console.log('─'.repeat(50))

            // Log detailed OCR output from Tesseract
            console.log(
                '🔍 [CAPTCHASolver] OCR word details:',
                result.data.words?.map((w) => ({
                    text: w.text,
                    confidence: w.confidence,
                    bbox: w.bbox,
                })) || 'No word details available',
            )

            console.log(
                '🔍 [CAPTCHASolver] OCR line details:',
                result.data.lines?.map((l) => ({
                    text: l.text,
                    confidence: l.confidence,
                    bbox: l.bbox,
                })) || 'No line details available',
            )

            console.log(
                '🔍 [CAPTCHASolver] OCR symbols/characters:',
                result.data.symbols?.map((s) => ({
                    text: s.text,
                    confidence: s.confidence,
                    bbox: s.bbox,
                })) || 'No symbol details available',
            )

            // Clean up the result
            const cleanedText = this.postProcessResult(result.data.text)
            console.log(`🧹 [CAPTCHASolver] Cleaned text: "${cleanedText}"`)

            // If confidence is low or no text detected, try alternative preprocessing
            if (
                (result.data.confidence < 50 && cleanedText.length < 3) ||
                cleanedText.length === 0
            ) {
                console.log(
                    '🔍 [CAPTCHASolver] Low confidence or no text detected, trying alternative preprocessing...',
                )
                const alternativeResult =
                    await this.tryAlternativePreprocessing(imagePath)
                if (
                    alternativeResult &&
                    alternativeResult.confidence > result.data.confidence
                ) {
                    console.log(
                        `✅ [CAPTCHASolver] Alternative preprocessing improved confidence: ${alternativeResult.confidence}%`,
                    )
                    return {
                        success: true,
                        text: alternativeResult.text,
                        confidence: alternativeResult.confidence,
                        originalText: alternativeResult.originalText,
                        preprocessedImagePath:
                            alternativeResult.preprocessedPath,
                        tempFiles: {
                            original: imagePath,
                            preprocessed: alternativeResult.preprocessedPath,
                            tempDir: this.tempDir,
                        },
                        ocrDetails: {
                            words: [],
                            lines: [],
                            symbols: [],
                        },
                    }
                }

                // If still no text, try OCR on original image
                if (cleanedText.length === 0) {
                    console.log(
                        '🔍 [CAPTCHASolver] Trying OCR on original image...',
                    )
                    const originalResult =
                        await this.worker.recognize(imagePath)
                    const originalCleanedText = this.postProcessResult(
                        originalResult.data.text,
                    )
                    if (originalCleanedText.length > 0) {
                        console.log(
                            `✅ [CAPTCHASolver] Original image OCR succeeded: "${originalCleanedText}"`,
                        )
                        return {
                            success: true,
                            text: originalCleanedText,
                            confidence: originalResult.data.confidence,
                            originalText: originalResult.data.text,
                            preprocessedImagePath: imagePath,
                            tempFiles: {
                                original: imagePath,
                                preprocessed: imagePath,
                                tempDir: this.tempDir,
                            },
                            ocrDetails: {
                                words: originalResult.data.words || [],
                                lines: originalResult.data.lines || [],
                                symbols: originalResult.data.symbols || [],
                            },
                        }
                    }
                }
            }

            return {
                success: true,
                text: cleanedText,
                confidence: result.data.confidence,
                originalText: result.data.text,
                preprocessedImagePath: preprocessedPath,
                tempFiles: {
                    original: imagePath,
                    preprocessed: preprocessedPath,
                    tempDir: this.tempDir,
                },
                ocrDetails: {
                    words: result.data.words || [],
                    lines: result.data.lines || [],
                    symbols: result.data.symbols || [],
                },
            }
        } catch (error) {
            console.error('💥 [CAPTCHASolver] Error solving CAPTCHA:', error)
            return {
                success: false,
                text: '',
                confidence: 0,
                error: error instanceof Error ? error.message : 'Unknown error',
                ocrDetails: {
                    words: [],
                    lines: [],
                    symbols: [],
                },
            }
        }
    }

    /**
     * Preprocess image using FFmpeg for better OCR
     */
    private async preprocessImage(
        inputPath: string,
        config: PreprocessingConfig,
    ): Promise<string | null> {
        console.log('🛠️ [CAPTCHASolver] Starting image preprocessing...')

        try {
            const outputPath = path.join(
                this.tempDir,
                `captcha_preprocessed_${Date.now()}.png`,
            )
            console.log(`📁 [CAPTCHASolver] Output path: ${outputPath}`)

            let ffmpegArgs = ['-i', inputPath]

            // Apply preprocessing steps
            if (config.scale !== 1.0) {
                console.log(
                    `📏 [CAPTCHASolver] Scaling image by ${config.scale}x`,
                )
                ffmpegArgs.push(
                    '-vf',
                    `scale=iw*${config.scale}:ih*${config.scale}`,
                )
            }

            if (config.contrast !== 1.0) {
                console.log(
                    `🎨 [CAPTCHASolver] Adjusting contrast to ${config.contrast}`,
                )
                ffmpegArgs.push('-vf', `eq=contrast=${config.contrast}`)
            }

            if (config.noiseReduction) {
                console.log('🔇 [CAPTCHASolver] Applying noise reduction')
                ffmpegArgs.push('-vf', 'nlmeans')
            }

            if (config.binarization) {
                console.log('⚫ [CAPTCHASolver] Applying binarization')
                ffmpegArgs.push('-vf', 'threshold')
            }

            if (config.deskew) {
                console.log('📐 [CAPTCHASolver] Applying deskew')
                ffmpegArgs.push('-vf', 'rotate=0')
            }

            if (config.sharpen) {
                console.log('🔪 [CAPTCHASolver] Applying sharpening')
                ffmpegArgs.push('-vf', 'unsharp=5:5:1.5:5:5:0.5')
            }

            ffmpegArgs.push('-y', outputPath)

            console.log(
                `🔄 [CAPTCHASolver] Running FFmpeg: ffmpeg ${ffmpegArgs.join(' ')}`,
            )

            const { stdout, stderr } = await exec(
                `ffmpeg ${ffmpegArgs.join(' ')}`,
            )

            if (stderr) {
                console.log(`📋 [CAPTCHASolver] FFmpeg stderr: ${stderr}`)
            }

            if (fs.existsSync(outputPath)) {
                const stats = fs.statSync(outputPath)
                console.log(
                    `✅ [CAPTCHASolver] Preprocessing completed: ${stats.size} bytes`,
                )
                return outputPath
            } else {
                console.error('❌ [CAPTCHASolver] Preprocessed image not found')
                return null
            }
        } catch (error) {
            console.error(
                '💥 [CAPTCHASolver] Error during image preprocessing:',
                error,
            )
            return null
        }
    }

    /**
     * Post-process OCR result to clean up the text
     */
    private postProcessResult(text: string): string {
        return text
            .trim()
            .replace(/[^A-Z0-9]/g, '') // Keep only alphanumeric characters
            .toUpperCase() // Convert to uppercase
    }

    /**
     * Terminate the Tesseract worker
     */
    public async terminate(): Promise<void> {
        if (this.worker) {
            await this.worker.terminate()
            this.worker = null
            this.isInitialized = false
            console.log('🛑 [CAPTCHASolver] Tesseract worker terminated')
        }
    }

    /**
     * Try alternative preprocessing configurations for better results
     */
    private async tryAlternativePreprocessing(imagePath: string): Promise<{
        text: string
        confidence: number
        originalText: string
        preprocessedPath: string
    } | null> {
        try {
            // Try different preprocessing configurations
            const configs = CAPTCHA_CONSTANTS.ALTERNATIVE_CONFIGS

            for (const config of configs) {
                console.log(
                    '🔍 [CAPTCHASolver] Trying alternative config:',
                    config,
                )
                const preprocessedPath = await this.preprocessImage(
                    imagePath,
                    config,
                )
                if (preprocessedPath) {
                    const result = await this.worker.recognize(preprocessedPath)
                    const cleanedText = this.postProcessResult(result.data.text)

                    if (result.data.confidence > 30 && cleanedText.length > 0) {
                        console.log(
                            `✅ [CAPTCHASolver] Alternative config succeeded: "${cleanedText}" (${result.data.confidence}%)`,
                        )
                        return {
                            text: cleanedText,
                            confidence: result.data.confidence,
                            originalText: result.data.text,
                            preprocessedPath,
                        }
                    }
                }
            }

            return null
        } catch (error) {
            console.warn(
                '⚠️ [CAPTCHASolver] Alternative preprocessing failed:',
                error,
            )
            return null
        }
    }

    /**
     * Check if the solver is ready
     */
    public isReady(): boolean {
        return this.isInitialized && this.worker !== null
    }
}
