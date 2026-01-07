import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'

import { Page } from 'playwright'
import { GLOBAL } from '../singleton'
import { MeetingEndReason } from '../state-machine/types'

import { HtmlSnapshotService } from '../services/html-snapshot-service'
import { calculateVideoOffset } from '../utils/CalculVideoOffset'
import { formatError } from '../utils/Logger'
import { PathManager } from '../utils/PathManager'
import { S3Uploader } from '../utils/S3Uploader'
import { sleep } from '../utils/sleep'
import { generateSyncSignal } from '../utils/SyncSignal'
import { SoundLevelMonitor } from '../utils/sound-level-monitor'

const TRANSCRIPTION_CHUNK_DURATION = 3600
const GRACE_PERIOD_SECONDS = 3
const DEFAULT_STREAMING_SAMPLE_RATE = 24_000
const AUDIO_SAMPLE_RATE = 44_100 // Improved audio quality
const AUDIO_BITRATE = '192k' // Improved audio bitrate
const FLASH_SCREEN_SLEEP_TIME = 4500 // Increased from 4200 for better stability in prod
const SCREENSHOT_PERIOD = 5 // every 5 seconds instead of 2
const SCREENSHOT_WIDTH = 480 // reduced for smaller file size (fixed, not affected by RESOLUTION)
const SCREENSHOT_HEIGHT = 270 // reduced for smaller file size (fixed, not affected by RESOLUTION)

// Environment variables for display and virtual speaker monitor
const DISPLAY = process.env.DISPLAY || ':99'
const VIRTUAL_SPEAKER_MONITOR =
    process.env.VIRTUAL_SPEAKER_MONITOR || 'virtual_speaker.monitor'

const UPLOAD_AUDIO_CHUNKS = process.env.UPLOAD_AUDIO_CHUNKS === 'true'
const UPLOAD_RAW_VIDEO = process.env.UPLOAD_RAW_VIDEO === 'true'

// Resolution configuration from environment variable (defaults to 720p)
function getResolution(): {
    width: number
    height: number
    captureHeight: number
} {
    const resolution = process.env.RESOLUTION || '720'
    if (resolution === '1080') {
        return {
            width: 1920,
            height: 1080,
            captureHeight: 1220, // 1080 + 140px for browser bar
        }
    }
    // Default to 720p
    return {
        width: 1280,
        height: 720,
        captureHeight: 860, // 720 + 140px for browser bar
    }
}

// Dynamic timeout configuration
const FFMPEG_TIMEOUTS = {
    SIMPLE_OPERATIONS: 5 * 60 * 1000, // 5 minutes
    COMPLEX_OPERATIONS: 30 * 60 * 1000, // 30 minutes
    CRITICAL_OPERATIONS: 45 * 60 * 1000, // 45 minutes
    MAX_CEILING: 60 * 60 * 1000, // 60 minutes (1 hour ceiling)
}

/**
 * Calculate dynamic timeout for FFmpeg operations based on operation type and file size
 */
const calculateFFmpegTimeout = (
    operation: string,
    fileSizeMB?: number,
): number => {
    const baseTimeout = 60000 // 1 minute base

    let timeout = baseTimeout

    switch (operation) {
        case 'mergeWithSync':
        case 'finalTrimFromOffset':
        case 'extractAudioFromVideo':
        case 'createAudioChunks':
            // Critical operations: Dynamic scaling based on file size with ceiling
            timeout = Math.max(
                FFMPEG_TIMEOUTS.COMPLEX_OPERATIONS,
                (fileSizeMB || 100) * 1000,
            )
            return Math.min(timeout, FFMPEG_TIMEOUTS.MAX_CEILING)
        case 'addSilencePadding':
        case 'trimAudioStart':
            // Simple audio operations
            return FFMPEG_TIMEOUTS.SIMPLE_OPERATIONS
        case 'getDuration':
            // Metadata operations
            return 30 * 1000 // 30 seconds
        default:
            // Default to complex operations timeout
            return Math.min(
                FFMPEG_TIMEOUTS.COMPLEX_OPERATIONS,
                FFMPEG_TIMEOUTS.MAX_CEILING,
            )
    }
}

interface ScreenRecordingConfig {
    display: string
    audioDevice?: string
}

export interface AudioWarningEvent {
    type: 'pulseAudioWarning'
    errorCount: number
    message: string
    timestamp: number
}

export class ScreenRecorder extends EventEmitter {
    private ffmpegProcess: ChildProcess | null = null
    private errorMonitorIntervalId: NodeJS.Timeout | null = null
    private forceKillTimeoutId: NodeJS.Timeout | null = null
    private fileSizeMonitorIntervalId: NodeJS.Timeout | null = null
    private outputPath: string = ''
    private audioOutputPath: string = ''
    private config: ScreenRecordingConfig
    private isRecording: boolean = false
    private filesUploaded: boolean = false
    private recordingStartTime: number = 0
    private meetingStartTime: number = 0
    private gracePeriodActive: boolean = false
    private rawAudioPath: string = ''
    private streamingSampleRate: number = DEFAULT_STREAMING_SAMPLE_RATE
    private soundMonitorRemainder: Buffer = Buffer.alloc(0)

    constructor(config: Partial<ScreenRecordingConfig> = {}) {
        super()

        this.config = {
            display: DISPLAY,
            audioDevice: 'pulse',
            ...config,
        }
    }

    private generateOutputPaths(): void {
        try {
            // Always generate both paths for consistent flow
            // Audio-only mode will just skip video upload at the end
            this.outputPath = PathManager.getInstance().getOutputPath() + '.mp4'
            this.audioOutputPath =
                PathManager.getInstance().getOutputPath() + '.wav'
        } catch (error) {
            console.error(
                'Failed to generate output paths:',
                formatError(error),
            )
            throw new Error('Failed to generate output paths')
        }
    }

    public setMeetingStartTime(startTime: number): void {
        this.meetingStartTime = startTime
    }

    public async startRecording(page: Page): Promise<void> {
        if (this.isRecording) {
            throw new Error('Recording is already in progress')
        }

        this.streamingSampleRate = GLOBAL.get().streaming_audio_frequency
            ? GLOBAL.get().streaming_audio_frequency
            : DEFAULT_STREAMING_SAMPLE_RATE

        // Capture DOM state before starting screen recording (void to avoid blocking)
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        void htmlSnapshot.captureSnapshot(page, 'screen_recording_start')

        this.generateOutputPaths()

        try {
            // Wait for audio devices to be ready before starting FFmpeg
            await this.waitForAudioDevices()

            const ffmpegArgs = this.buildNativeFFmpegArgs()

            this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            this.isRecording = true
            this.recordingStartTime = Date.now()
            this.gracePeriodActive = false
            this.logMemoryUsage('Starting recording')
            this.setupProcessMonitoring()
            this.setupSoundLevelMonitoring()
            this.setupFileSizeMonitoring()

            await sleep(FLASH_SCREEN_SLEEP_TIME)
            await generateSyncSignal(page, {
                duration: 800, // Much longer signal for reliable detection
                frequency: 1000, // Keep 1000Hz for consistency
                volume: 0.95, // Higher volume for better detection
            })

            console.log('Native recording started successfully')
            this.emit('started', {
                outputPath: this.outputPath,
                isAudioOnly: GLOBAL.get().recording_mode === 'audio_only',
            })
        } catch (error) {
            console.error(
                'Failed to start native recording:',
                formatError(error),
            )
            this.isRecording = false
            this.emit('error', { type: 'startError', error })
        }
    }

    private async waitForAudioDevices(): Promise<void> {
        const maxAttempts = 15
        const delayMs = 1000

        console.log('🔍 Waiting for audio devices to be ready...')

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Get the assigned virtual speaker monitor from environment

                // Check if the assigned virtual speaker monitor exists
                const { spawn } = await import('child_process')
                const checkProcess = spawn('pactl', [
                    'list',
                    'sources',
                    'short',
                ])

                let output = ''
                checkProcess.stdout?.on('data', (data) => {
                    output += data.toString()
                })

                const exitCode = await new Promise<number>((resolve) => {
                    checkProcess.on('close', resolve)
                })

                if (
                    exitCode === 0 &&
                    output.includes(VIRTUAL_SPEAKER_MONITOR)
                ) {
                    console.log(
                        `✅ Audio device ready after ${attempt} attempt(s)`,
                    )
                    return
                }

                console.log(
                    `⏳ Attempt ${attempt}/${maxAttempts}: audio device not ready, waiting ${delayMs}ms...`,
                )
                await sleep(delayMs)
            } catch (error) {
                console.warn(
                    `⚠️ Attempt ${attempt}/${maxAttempts}: Error checking audio device:`,
                    error,
                )
                await sleep(delayMs)
            }
        }

        // If we get here, devices are still not ready - try a quick FFmpeg test
        console.warn(
            `⚠️ Audio devices not confirmed ready after ${maxAttempts} attempts, testing with FFmpeg...`,
        )

        try {
            const testProcess = spawn('ffmpeg', [
                '-f',
                'pulse',
                '-i',
                VIRTUAL_SPEAKER_MONITOR,
                '-t',
                '0.1',
                '-f',
                'null',
                '-',
            ])

            const testExitCode = await new Promise<number>((resolve) => {
                testProcess.on('close', resolve)
            })

            if (testExitCode === 0) {
                console.log(
                    '✅ FFmpeg audio test successful - devices are ready',
                )
                return
            }
        } catch (error) {
            console.error('❌ FFmpeg audio test failed:', formatError(error))
        }

        throw new Error(
            `Audio devices not ready after maximum wait time - ${VIRTUAL_SPEAKER_MONITOR} unavailable`,
        )
    }

    private buildNativeFFmpegArgs(): string[] {
        const args: string[] = []
        const res = getResolution()

        console.log(
            `🛠️ Building FFmpeg args for separate audio/video recording (resolution: ${res.width}x${res.height})...`,
        )

        const screenshotsPath = PathManager.getInstance().getScreenshotsPath()
        const timestamp = Date.now()
        const screenshotPattern = path.join(
            screenshotsPath,
            `${timestamp}_%4d.png`,
        )

        // Use the same recording flow for both audio-only and video modes
        // Audio-only mode will just skip video upload at the end
        const tempDir = PathManager.getInstance().getTempPath()
        const rawVideoPath = path.join(tempDir, 'raw.mp4')
        this.rawAudioPath = path.join(tempDir, 'raw.wav')

        args.push(
            // === VIDEO INPUT ===
            '-f',
            'x11grab',
            '-video_size',
            `${res.width}x${res.captureHeight}`,
            '-framerate',
            '30',
            '-i',
            this.config.display,

            // === AUDIO INPUT ===
            '-f',
            'pulse',
            '-thread_queue_size',
            '4096', // Buffer size for audio capture stability
            '-i',
            VIRTUAL_SPEAKER_MONITOR,

            // === OUTPUT 1: RAW VIDEO (no audio) ===
            '-map',
            '0:v:0',
            '-c:v',
            'libx264',
            '-preset',
            'fast',
            '-crf',
            '23',
            '-profile:v',
            'main',
            '-level',
            '4.0',
            '-pix_fmt',
            'yuv420p',
            '-g',
            '30', // Keyframe every 30 frames (1 sec at 30fps) for precise trimming
            '-keyint_min',
            '30', // Force minimum keyframe interval
            '-bf',
            '0',
            '-refs',
            '1',
            '-vf',
            `crop=${res.width}:${res.height}:0:140`,
            '-avoid_negative_ts',
            'make_zero',
            '-f',
            'mp4',
            '-y',
            rawVideoPath,

            // === OUTPUT 2: RAW AUDIO ===
            '-map',
            '1:a:0',
            '-vn',
            '-acodec',
            'pcm_s16le',
            '-ac',
            '1',
            '-ar',
            AUDIO_SAMPLE_RATE.toString(),
            '-avoid_negative_ts',
            'make_zero',
            '-f',
            'wav',
            '-y',
            this.rawAudioPath,

            // === OUTPUT 3: SCREENSHOTS (every 5 seconds) - fixed resolution ===
            '-map',
            '0:v:0',
            '-vf',
            `fps=${1 / SCREENSHOT_PERIOD},crop=${res.width}:${res.height}:0:140,scale=${SCREENSHOT_WIDTH}:${SCREENSHOT_HEIGHT}`,
            '-q:v',
            '3', // High quality JPEG compression
            '-f',
            'image2',
            '-y',
            screenshotPattern,

            // === OUTPUT 4: SOUND LEVEL MONITORING (stdout) ===
            // This output is CRITICAL for automatic leave detection
            // It feeds the SoundLevelMonitor which is independent of streaming
            '-map',
            '1:a:0',
            '-acodec',
            'pcm_f32le', // Float32 for easy processing
            '-ac',
            '1', // Mono
            '-ar',
            '24000', // 24kHz is sufficient for sound level analysis
            '-f',
            'f32le', // Raw float32 format
            'pipe:1', // stdout
        )

        return args
    }

    private setupProcessMonitoring(): void {
        if (!this.ffmpegProcess) return

        this.ffmpegProcess.on('error', (error) => {
            console.error('FFmpeg error:', formatError(error))
            this.emit('error', error)
        })

        this.ffmpegProcess.on('exit', async (code) => {
            console.log(`FFmpeg exited with code ${code}`)

            // Consider recording successful if:
            // - Exit code 0 (normal completion)
            // - Exit code 255 or 143 (SIGINT/SIGTERM) when we're in grace period (requested shutdown)
            const isSuccessful =
                code === 0 ||
                (this.gracePeriodActive && (code === 255 || code === 143))

            if (isSuccessful) {
                console.log('✅ Recording considered successful, uploading...')
                try {
                    await this.handleSuccessfulRecording()
                } catch (error) {
                    console.error(
                        '❌ Error in handleSuccessfulRecording:',
                        error instanceof Error ? error.message : error,
                    )
                    this.emit('error', error)
                    return
                }
            } else {
                console.warn(
                    `⚠️ Recording failed - unexpected exit code: ${code}`,
                )
            }

            this.isRecording = false
            this.cleanupProcess()
            this.emit('stopped')
        })

        // Enhanced error monitoring for PulseAudio issues
        let errorCount = 0
        const maxErrors = 15 // Threshold for PulseAudio errors (buffer reduced to 4096 for latency)
        const errorWindowMs = 60000 // 60 seconds window
        let lastErrorTime = 0
        const errorCooldownMs = 10000 // 10 second cooldown - less aggressive
        let consecutiveErrors = 0
        const maxConsecutiveErrors = 10 // Much less aggressive

        this.ffmpegProcess.stderr?.on('data', (data) => {
            const output = data.toString()
            const outputLower = output.toLowerCase()
            if (outputLower.includes('error')) {
                console.error('FFmpeg stderr:', output.trim())

                // Check for file write/I/O errors that indicate disk/filesystem issues
                if (
                    outputLower.includes('error writing output file') ||
                    outputLower.includes('i/o error') ||
                    outputLower.includes('no space left on device') ||
                    outputLower.includes('disk full') ||
                    outputLower.includes('filesystem full') ||
                    outputLower.includes('cannot write') ||
                    outputLower.includes('write error') ||
                    outputLower.includes('broken pipe') ||
                    outputLower.includes('connection reset') ||
                    outputLower.includes('connection refused')
                ) {
                    const now = Date.now()
                    const recordingDurationSeconds =
                        this.recordingStartTime > 0
                            ? (now - this.recordingStartTime) / 1000
                            : 0

                    // Log file size at time of error for diagnostics
                    let currentFileSize = 'unknown'
                    try {
                        if (
                            this.rawAudioPath &&
                            fs.existsSync(this.rawAudioPath)
                        ) {
                            const stats = fs.statSync(this.rawAudioPath)
                            currentFileSize = `${(stats.size / (1024 * 1024)).toFixed(2)} MB (${stats.size} bytes)`
                        }
                    } catch (e) {
                        // Ignore file stat errors
                    }

                    console.error(
                        `❌ CRITICAL: FFmpeg file write error detected!`,
                    )
                    console.error(
                        `   📊 Recording duration: ${recordingDurationSeconds.toFixed(1)}s`,
                    )
                    console.error(
                        `   📁 Raw audio file size: ${currentFileSize}`,
                    )
                    console.error(`   🔍 Error details: ${output.trim()}`)

                    // Log system resources for diagnostics
                    this.logSystemResources()

                    // Emit a critical error event
                    ;(this as EventEmitter).emit('error', {
                        type: 'fileWriteError',
                        message: 'FFmpeg file write error detected',
                        error: output.trim(),
                        recordingDuration: recordingDurationSeconds,
                        currentFileSize,
                        timestamp: now,
                    })
                }
                // Check for specific PulseAudio errors that indicate audio input failure
                else if (
                    outputLower.includes('error during demuxing') ||
                    outputLower.includes(
                        'error retrieving a packet from demuxer',
                    ) ||
                    outputLower.includes(
                        'generic error in an external library',
                    ) ||
                    outputLower.includes('connection lost') ||
                    outputLower.includes('broken pipe')
                ) {
                    const now = Date.now()
                    errorCount++
                    consecutiveErrors++

                    // Enhanced error logging with context
                    const memoryUsage = process.memoryUsage()
                    const memoryMB = Math.round(memoryUsage.rss / 1024 / 1024)
                    const uptime = Math.round(
                        (Date.now() - this.recordingStartTime) / 1000,
                    )

                    console.warn(
                        `⚠️ PulseAudio demuxing error detected (${errorCount}/${maxErrors}, consecutive: ${consecutiveErrors}/${maxConsecutiveErrors})`,
                    )
                    console.warn(
                        `   📊 Context: Memory=${memoryMB}MB, Uptime=${uptime}s, Process=${this.ffmpegProcess?.pid}`,
                    )
                    console.warn(`   🔍 Error details: ${output.trim()}`)

                    // Log system resource status
                    this.logSystemResources()

                    // Only emit warning if enough errors accumulate
                    if (
                        errorCount >= maxErrors &&
                        now - lastErrorTime > errorCooldownMs
                    ) {
                        lastErrorTime = now
                        console.warn(
                            '⚠️ Multiple PulseAudio errors detected, but continuing recording with larger buffers...',
                        )

                        // Emit a warning event for monitoring purposes
                        const audioWarning: AudioWarningEvent = {
                            type: 'pulseAudioWarning',
                            errorCount,
                            message:
                                'PulseAudio input stream experiencing issues - monitoring with increased buffers',
                            timestamp: Date.now(),
                        }
                        this.emit('audioWarning', audioWarning)
                    }
                } else {
                    // Reset consecutive error count on non-PulseAudio errors
                    consecutiveErrors = Math.max(0, consecutiveErrors - 1)
                }
            } else {
                // Reset consecutive error count on successful output
                consecutiveErrors = Math.max(0, consecutiveErrors - 1)
            }
        })

        // Reset error count periodically but less frequently
        this.errorMonitorIntervalId = setInterval(() => {
            if (errorCount > 0) {
                console.log(
                    `🔄 Resetting PulseAudio error count (was ${errorCount})`,
                )
                errorCount = 0
                lastErrorTime = 0
                consecutiveErrors = 0
            }
        }, errorWindowMs)
    }

    /**
     * Setup sound level monitoring from FFmpeg stdout
     * This is CRITICAL for automatic leave detection (silence timeout, noone_joined_timeout)
     * Completely independent of streaming functionality
     */
    private setupSoundLevelMonitoring(): void {
        if (!this.ffmpegProcess) return

        const monitor = SoundLevelMonitor.getInstance()
        monitor.start()

        try {
            this.ffmpegProcess.stdout?.on('data', (data: Buffer) => {
                try {
                    // Handle chunk boundaries: Float32 frames can split across data events
                    // Concatenate with any remainder from previous chunk
                    let buf: Buffer
                    if (this.soundMonitorRemainder.length > 0) {
                        // Due to iterator type differences in @types/node definitions. Buffer extends Uint8Array
                        // at runtime and Buffer.concat() handles this correctly. This is a known TypeScript issue.
                        buf = Buffer.concat([
                            this.soundMonitorRemainder as unknown as Uint8Array,
                            data as unknown as Uint8Array,
                        ])
                    } else {
                        buf = data
                    }

                    // Only process aligned bytes (divisible by 4 for Float32)
                    const alignedLen = buf.length - (buf.length % 4)
                    if (alignedLen === 0) {
                        // Not enough data yet, save for next chunk
                        this.soundMonitorRemainder = buf
                        return
                    }

                    // Save unaligned remainder for next chunk
                    this.soundMonitorRemainder = buf.subarray(
                        alignedLen,
                    ) as Buffer

                    // Create Float32Array view and copy to avoid retaining pooled buffers
                    const view = new Float32Array(
                        buf.buffer,
                        buf.byteOffset,
                        alignedLen / 4,
                    )
                    const float32Array = new Float32Array(view) // Copy to standalone array

                    // Feed to sound level monitor (always active, critical for automatic leave)
                    monitor.processAudioChunk(float32Array)
                } catch (error) {
                    console.error(
                        '[SoundLevelMonitor] Failed to process audio chunk:',
                        formatError(error),
                    )
                    // Don't throw - continue processing other chunks
                }
            })

            console.log(
                '✅ Sound level monitoring enabled (FFmpeg stdout → automatic leave detection)',
            )
        } catch (error) {
            console.error(
                '[SoundLevelMonitor] Failed to setup monitoring:',
                formatError(error),
            )
        }
    }

    private setupFileSizeMonitoring(): void {
        if (!this.rawAudioPath) return

        let lastFileSize = 0
        let lastCheckTime = Date.now()
        let consecutiveNoGrowthCount = 0
        const FILE_SIZE_CHECK_INTERVAL = 30000 // 30 seconds
        const MAX_CONSECUTIVE_NO_GROWTH = 3 // Warn after 3 consecutive checks with no growth (90 seconds)

        this.fileSizeMonitorIntervalId = setInterval(() => {
            try {
                if (!fs.existsSync(this.rawAudioPath)) {
                    // File doesn't exist yet, skip this check
                    return
                }

                const stats = fs.statSync(this.rawAudioPath)
                const currentSize = stats.size
                const currentTime = Date.now()
                const recordingDurationSeconds =
                    (currentTime - this.recordingStartTime) / 1000
                const sizeMB = (currentSize / (1024 * 1024)).toFixed(2)

                // Check if file size has grown since last check
                const hasGrown = currentSize > lastFileSize
                const timeSinceLastCheck = (currentTime - lastCheckTime) / 1000

                if (hasGrown) {
                    consecutiveNoGrowthCount = 0
                    const growthBytes = currentSize - lastFileSize
                    const growthMB = (growthBytes / (1024 * 1024)).toFixed(2)
                    const growthRate = growthBytes / timeSinceLastCheck // bytes per second
                    const growthRateMBps = (growthRate / (1024 * 1024)).toFixed(
                        2,
                    )

                    console.log(
                        `📊 Raw audio file size: ${sizeMB} MB (${currentSize} bytes) | Recording: ${recordingDurationSeconds.toFixed(1)}s | Growth: +${growthMB} MB in ${timeSinceLastCheck.toFixed(1)}s (${growthRateMBps} MB/s)`,
                    )
                } else {
                    consecutiveNoGrowthCount++
                    if (consecutiveNoGrowthCount >= MAX_CONSECUTIVE_NO_GROWTH) {
                        console.warn(
                            `⚠️ WARNING: Raw audio file has not grown for ${consecutiveNoGrowthCount * (FILE_SIZE_CHECK_INTERVAL / 1000)}s! Current: ${sizeMB} MB (${currentSize} bytes) | Recording: ${recordingDurationSeconds.toFixed(1)}s. This may indicate a silent write failure.`,
                        )
                    } else {
                        console.log(
                            `📊 Raw audio file size: ${sizeMB} MB (${currentSize} bytes) | Recording: ${recordingDurationSeconds.toFixed(1)}s | No growth detected (${consecutiveNoGrowthCount}/${MAX_CONSECUTIVE_NO_GROWTH})`,
                        )
                    }
                }

                lastFileSize = currentSize
                lastCheckTime = currentTime
            } catch (error) {
                // Don't log errors for missing files during early recording
                if (fs.existsSync(this.rawAudioPath)) {
                    console.warn(
                        `⚠️ Error checking raw audio file size: ${error}`,
                    )
                }
            }
        }, FILE_SIZE_CHECK_INTERVAL)
    }

    private async uploadAudioChunks(
        chunksDir: string,
        botUuid: string,
    ): Promise<void> {
        if (!S3Uploader.getInstance()) return

        try {
            const files = fs.readdirSync(chunksDir)
            const chunkFiles = files.filter(
                (file) =>
                    file.startsWith(`${botUuid}-`) && file.endsWith('.wav'),
            )

            console.log(`📤 Uploading ${chunkFiles.length} audio chunks...`)

            for (const filename of chunkFiles) {
                const chunkPath = path.join(chunksDir, filename)

                if (!fs.existsSync(chunkPath)) {
                    console.warn(`Chunk file not found: ${chunkPath}`)
                    continue
                }

                try {
                    const stats = fs.statSync(chunkPath)
                    if (stats.size === 0) {
                        console.warn(`Chunk file is empty: ${filename}`)
                        continue
                    }

                    const s3Key = `${botUuid}/${filename}`
                    console.log(
                        `📤 Uploading chunk: ${filename} (${stats.size} bytes)`,
                    )

                    await S3Uploader.getInstance().uploadFile(
                        chunkPath,
                        GLOBAL.get().aws_s3_temporary_audio_bucket,
                        s3Key,
                    )

                    console.log(`✅ Chunk uploaded: ${filename}`)
                } catch (error) {
                    console.error(
                        `Failed to upload chunk ${filename}:`,
                        formatError(error),
                    )
                }
            }
        } catch (error) {
            console.error(
                'Failed to read chunks directory:',
                formatError(error),
            )
        }
    }

    public async uploadToS3(): Promise<void> {
        if (this.filesUploaded || !S3Uploader.getInstance()) {
            return
        }

        const identifier = PathManager.getInstance().getIdentifier()

        try {
            if (fs.existsSync(this.audioOutputPath)) {
                const stats = fs.statSync(this.audioOutputPath)
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2)
                const sizeBytes = stats.size
                const recordingDurationSeconds =
                    this.recordingStartTime > 0
                        ? (Date.now() - this.recordingStartTime) / 1000
                        : 0

                console.log(
                    `📤 Uploading WAV audio to video bucket: ${GLOBAL.get().remote?.aws_s3_video_bucket}`,
                )
                console.log(
                    `📊 Audio file size before upload: ${sizeMB} MB (${sizeBytes} bytes) | Recording duration: ${recordingDurationSeconds.toFixed(1)}s`,
                )

                await S3Uploader.getInstance().uploadFile(
                    this.audioOutputPath,
                    GLOBAL.get().remote?.aws_s3_video_bucket!,
                    `${identifier}.wav`,
                )
                fs.unlinkSync(this.audioOutputPath)
            }
        } catch (error) {
            console.error('Failed to upload audio file:', formatError(error))
            // Don't throw - continue with video upload
        }

        // Only upload video if not in audio-only mode
        if (GLOBAL.get().recording_mode !== 'audio_only') {
            try {
                if (fs.existsSync(this.outputPath)) {
                    const stats = fs.statSync(this.outputPath)
                    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2)
                    const sizeBytes = stats.size

                    console.log(
                        `📤 Uploading MP4 to video bucket: ${GLOBAL.get().remote?.aws_s3_video_bucket}`,
                    )
                    console.log(
                        `📊 Video file size before upload: ${sizeMB} MB (${sizeBytes} bytes)`,
                    )

                    await S3Uploader.getInstance().uploadFile(
                        this.outputPath,
                        GLOBAL.get().remote?.aws_s3_video_bucket!,
                        `${identifier}.mp4`,
                    )
                    fs.unlinkSync(this.outputPath)
                }
            } catch (error) {
                console.error(
                    'Failed to upload video file:',
                    formatError(error),
                )
                // Don't throw - mark as uploaded to allow process completion
            }
        } else {
            // Audio-only mode: skip video upload, just clean up if it exists
            if (fs.existsSync(this.outputPath)) {
                try {
                    fs.unlinkSync(this.outputPath)
                    console.log(
                        '🗑️ Skipped video upload (audio-only mode), cleaned up video file',
                    )
                } catch (error) {
                    console.warn(
                        'Failed to clean up video file:',
                        formatError(error),
                    )
                }
            }
        }

        this.filesUploaded = true
    }

    public async stopRecording(): Promise<void> {
        if (!this.isRecording || !this.ffmpegProcess) {
            return
        }

        // Capture exit time right when recording stops (before grace period and processing)
        const exitTime = Math.floor(Date.now() / 1000)
        console.log(`Bot exit time captured as ${exitTime}`)
        GLOBAL.setExitTime(exitTime)

        console.log('🛑 Stop recording requested - starting grace period...')
        this.gracePeriodActive = true

        const gracePeriodMs = GRACE_PERIOD_SECONDS * 1000

        // Wait for grace period to allow clean ending
        console.log(
            `⏳ Grace period: ${GRACE_PERIOD_SECONDS}s for clean ending`,
        )

        await new Promise<void>((resolve) => {
            setTimeout(() => {
                console.log(
                    '✅ Grace period completed - stopping FFmpeg cleanly',
                )
                resolve()
            }, gracePeriodMs)
        })

        return new Promise((resolve, reject) => {
            // Wait for the 'stopped' event instead of 'exit' to ensure upload is complete
            this.once('stopped', () => {
                this.gracePeriodActive = false
                this.cleanupProcess()
                resolve()
            })

            this.once('error', (error) => {
                console.error(
                    'ScreenRecorder error during stop:',
                    error instanceof Error ? error.message : error,
                )
                this.gracePeriodActive = false
                this.cleanupProcess()
                reject(error)
            })

            // Send graceful termination signal
            this.ffmpegProcess!.kill('SIGINT')

            // Fallback force kill after timeout
            this.forceKillTimeoutId = setTimeout(() => {
                if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
                    console.warn('⚠️ Force killing FFmpeg process')
                    this.ffmpegProcess.kill('SIGKILL')
                }
                this.forceKillTimeoutId = null
            }, 8000)
        })
    }

    private cleanupProcess(): void {
        // Log memory usage before cleanup
        this.logMemoryUsage('Before cleanup')

        // Clear error monitor interval to prevent memory leaks
        if (this.errorMonitorIntervalId) {
            clearInterval(this.errorMonitorIntervalId)
            this.errorMonitorIntervalId = null
        }

        // Clear file size monitor interval to prevent memory leaks
        if (this.fileSizeMonitorIntervalId) {
            clearInterval(this.fileSizeMonitorIntervalId)
            this.fileSizeMonitorIntervalId = null
        }

        // Clear force kill timeout to prevent memory leaks
        if (this.forceKillTimeoutId) {
            clearTimeout(this.forceKillTimeoutId)
            this.forceKillTimeoutId = null
        }

        // Remove all event listeners from stdout/stderr and process to prevent memory leaks
        if (this.ffmpegProcess) {
            // Remove listeners from stdout if it exists
            if (this.ffmpegProcess.stdout) {
                this.ffmpegProcess.stdout.removeAllListeners()
            }
            // Remove listeners from stderr if it exists
            if (this.ffmpegProcess.stderr) {
                this.ffmpegProcess.stderr.removeAllListeners()
            }
            // Remove all listeners from the process itself
            this.ffmpegProcess.removeAllListeners()
            this.ffmpegProcess = null
        }

        // Log memory usage after cleanup
        this.logMemoryUsage('After cleanup')
    }

    private logMemoryUsage(context: string): void {
        const usage = process.memoryUsage()
        console.log(
            `💾 Memory usage ${context}: RSS=${Math.round(usage.rss / 1024 / 1024)}MB, Heap=${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
        )
    }

    private logSystemResources(): void {
        try {
            // Log FFmpeg process count
            const { execSync } = require('child_process')
            const ffmpegCount = execSync('pgrep -c ffmpeg || echo 0', {
                encoding: 'utf8',
            }).trim()
            const pulseCount = execSync('pgrep -c pulseaudio || echo 0', {
                encoding: 'utf8',
            }).trim()

            console.warn(
                `   🔍 System status: FFmpeg processes=${ffmpegCount}, PulseAudio processes=${pulseCount}`,
            )

            // Log file descriptor count if available
            try {
                const fdCount = execSync(`lsof -p ${process.pid} | wc -l`, {
                    encoding: 'utf8',
                }).trim()
                console.warn(`   📁 File descriptors: ${fdCount}`)
            } catch (e) {
                // Ignore if lsof not available
            }
        } catch (error) {
            console.warn(
                `   ⚠️ Could not gather system resource info: ${error}`,
            )
        }
    }

    public isCurrentlyRecording(): boolean {
        return this.isRecording
    }

    public getStatus(): {
        isRecording: boolean
        gracePeriodActive: boolean
        recordingDurationMs: number
    } {
        return {
            isRecording: this.isRecording,
            gracePeriodActive: this.gracePeriodActive,
            recordingDurationMs:
                this.recordingStartTime > 0
                    ? Date.now() - this.recordingStartTime
                    : 0,
        }
    }

    private async handleSuccessfulRecording(): Promise<void> {
        console.log('Native recording completed')

        try {
            // Sync and merge separate audio/video files
            await this.syncAndMergeFiles()

            // Auto-upload if not serverless and wait for completion
            if (!GLOBAL.isServerless()) {
                try {
                    await this.uploadToS3()
                    console.log('✅ Upload completed successfully')
                } catch (error) {
                    console.error('❌ Upload failed:', formatError(error))
                }
            }
        } catch (error) {
            console.error(
                '❌ Error during recording processing:',
                formatError(error),
            )

            if (error instanceof Error) {
                if (
                    error.message.includes('FFprobe failed') ||
                    error.message.includes('FFmpeg failed')
                ) {
                    // Check if we already have a BotNotAccepted error (higher priority)
                    if (
                        GLOBAL.hasError() &&
                        GLOBAL.getEndReason() ===
                            MeetingEndReason.BotNotAccepted
                    ) {
                        console.log(
                            'Preserving existing BotNotAccepted error instead of creating BotRemovedTooEarly',
                        )
                        throw error // Re-throw the original error to preserve BotNotAccepted
                    }

                    console.log(
                        'Converting FFprobe/FFmpeg error to BotRemovedTooEarly',
                    )
                    GLOBAL.setError(MeetingEndReason.BotRemovedTooEarly)
                    throw new Error('Bot removed too early')
                }
            }

            // Re-throw the error so it propagates to the caller
            throw error
        }
    }

    private async syncAndMergeFiles(): Promise<void> {
        // Use the same sync and merge flow for both audio-only and video modes
        // Audio-only mode will just skip video upload at the end
        const tempDir = PathManager.getInstance().getTempPath()
        const rawVideoPath = path.join(tempDir, 'raw.mp4')
        const rawAudioPath = path.join(tempDir, 'raw.wav')

        console.log(
            '🔄 Starting efficient sync and merge for long recording...',
        )

        // 0. Log raw audio file size before processing
        if (fs.existsSync(rawAudioPath)) {
            const stats = fs.statSync(rawAudioPath)
            const fileSizeBytes = stats.size
            const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2)
            const recordingDurationSeconds =
                this.recordingStartTime > 0
                    ? (Date.now() - this.recordingStartTime) / 1000
                    : 0

            console.log(
                `📊 Raw audio file size: ${fileSizeMB} MB (${fileSizeBytes} bytes) | Recording duration: ${recordingDurationSeconds.toFixed(1)}s`,
            )
        } else {
            console.warn('⚠️ Raw audio file not found:', rawAudioPath)
        }

        // 1. Calculate sync offset (using your existing calculation)
        const syncResult = await calculateVideoOffset(
            rawAudioPath,
            rawVideoPath,
        )
        console.log(
            `🎯 Calculated sync offset: ${syncResult.offsetSeconds.toFixed(3)}s`,
        )
        const hasMeetingStartTime = this.meetingStartTime > 0

        // 2. Check if meetingStartTime is properly set - if not, bot was not accepted
        if (!hasMeetingStartTime) {
            console.error(
                `❌ Bot not accepted - meetingStartTime not set (${this.meetingStartTime})`,
            )
            console.error(`📊 Timing debug:`)
            console.error(`   recordingStartTime: ${this.recordingStartTime}`)
            console.error(`   meetingStartTime: ${this.meetingStartTime}`)
            console.error(`   Current time: ${Date.now()}`)
            console.error(
                `   Recording duration: ${Date.now() - this.recordingStartTime}ms`,
            )

            // Fallback: if we have a reasonable recording duration (>10s), set meetingStartTime to 5s before bot removal
            const recordingDuration = Date.now() - this.recordingStartTime
            if (recordingDuration > 10000) {
                // 10 seconds minimum
                console.warn(
                    `⚠️ Setting meetingStartTime to 5s before bot removal to avoid showing pre-meeting phase`,
                )
                this.meetingStartTime = Date.now() - 5000 // Show only last 5 seconds
            } else {
                GLOBAL.setError(MeetingEndReason.BotNotAccepted)
                throw new Error('Bot not accepted into meeting')
            }
        }

        // 3. Calculate final trim points using meeting timing
        const calcOffsetVideo =
            syncResult.videoTimestamp +
            (this.meetingStartTime -
                this.recordingStartTime -
                FLASH_SCREEN_SLEEP_TIME) /
                1000

        console.log(`📊 Debug values:`)
        console.log(
            `   syncResult.videoTimestamp: ${syncResult.videoTimestamp}s`,
        )
        console.log(
            `   syncResult.audioTimestamp: ${syncResult.audioTimestamp}s`,
        )
        console.log(`   meetingStartTime: ${this.meetingStartTime}`)
        console.log(`   recordingStartTime: ${this.recordingStartTime}`)
        console.log(`   FLASH_SCREEN_SLEEP_TIME: ${FLASH_SCREEN_SLEEP_TIME}`)
        console.log(
            `   Time diff: ${(this.meetingStartTime - this.recordingStartTime - FLASH_SCREEN_SLEEP_TIME) / 1000}s`,
        )

        // 4. Calculate audio padding needed (can be negative for trimming)
        const audioPadding =
            syncResult.videoTimestamp - syncResult.audioTimestamp

        console.log(`🔇 Audio padding needed: ${audioPadding.toFixed(3)}s`)

        // 5. Prepare audio with padding or trimming if needed
        const processedAudioPath = path.join(tempDir, 'processed.wav')
        if (audioPadding > 0) {
            console.log(
                `🔇 Adding ${audioPadding.toFixed(3)}s silence to audio start (video ahead)...`,
            )
            await this.addSilencePadding(
                rawAudioPath,
                processedAudioPath,
                audioPadding,
            )
        } else if (audioPadding < 0) {
            console.log(
                `✂️ Trimming ${(audioPadding * -1).toFixed(3)}s from audio start (video behind)...`,
            )
            await this.trimAudioStart(
                rawAudioPath,
                processedAudioPath,
                audioPadding * -1,
            )
        } else {
            // No padding or trimming needed, just copy
            fs.copyFileSync(rawAudioPath, processedAudioPath)
        }

        // 6. Merge video and audio (both files are now synchronized from start)
        const mergedPath = path.join(tempDir, 'merged.mp4')
        await this.mergeWithSync(rawVideoPath, processedAudioPath, mergedPath)

        const videoDuration = await this.getDuration(rawVideoPath)
        const audioDuration = await this.getDuration(processedAudioPath)
        const finalDuration = Math.min(
            videoDuration - calcOffsetVideo,
            audioDuration,
        )

        console.log(`📊 Final duration: ${finalDuration.toFixed(2)}s`)
        await this.finalTrimFromOffset(
            mergedPath,
            this.outputPath,
            calcOffsetVideo,
            finalDuration,
        )

        // 7. Upload raw video for debugging (if enabled)
        if (
            UPLOAD_RAW_VIDEO &&
            fs.existsSync(rawVideoPath) &&
            S3Uploader.getInstance()
        ) {
            try {
                const identifier = PathManager.getInstance().getIdentifier()
                const stats = fs.statSync(rawVideoPath)
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2)
                const sizeBytes = stats.size

                console.log(
                    `📤 Uploading raw video to logs bucket for debugging...`,
                )
                console.log(
                    `📊 Raw video file size: ${sizeMB} MB (${sizeBytes} bytes)`,
                )

                const s3Key = `${identifier}/raw_video.mp4`
                await S3Uploader.getInstance()!.uploadFile(
                    rawVideoPath,
                    GLOBAL.get().remote?.aws_s3_log_bucket!,
                    s3Key,
                    { raw_upload: 'true' },
                )

                console.log(
                    `✅ Raw video uploaded to logs bucket: ${s3Key} (tagged with raw_upload=true)`,
                )
            } catch (error) {
                console.warn(
                    `⚠️ Failed to upload raw video for debugging: ${formatError(error)}`,
                )
                // Don't throw - continue with processing
            }
        }

        // 8. Extract audio from the final trimmed video (ensures perfect sync)
        try {
            await this.extractAudioFromVideo(
                this.outputPath,
                this.audioOutputPath,
            )
            console.log(
                `✅ Audio extracted from final video: ${this.audioOutputPath}`,
            )

            // 9. Create audio chunks from the extracted audio
            await this.createAudioChunks(this.audioOutputPath)
        } catch (error) {
            console.warn(
                `⚠️ Audio extraction failed (likely due to bot removal): ${error}`,
            )
            console.warn(
                `⚠️ Continuing without audio extraction to prevent bot hang`,
            )
            // Don't throw - allow cleanup to continue
        }

        // 10. Cleanup temporary files
        await this.cleanupTempFiles([
            rawVideoPath,
            rawAudioPath,
            processedAudioPath,
            mergedPath,
        ])

        console.log('✅ Efficient sync and merge completed successfully')
    }

    private async addSilencePadding(
        inputAudioPath: string,
        outputAudioPath: string,
        paddingSeconds: number,
    ): Promise<void> {
        const tempDir = PathManager.getInstance().getTempPath()
        const silenceFile = path.join(tempDir, 'silence.wav')
        const concatListFile = path.join(tempDir, 'concat_list.txt')

        // Create silence file with exact same format as input
        const silenceArgs = [
            '-f',
            'lavfi',
            '-i',
            `anullsrc=channel_layout=mono:sample_rate=${AUDIO_SAMPLE_RATE}:duration=${paddingSeconds}`,
            '-c:a',
            'pcm_s16le',
            '-ar',
            AUDIO_SAMPLE_RATE.toString(),
            '-ac',
            '1',
            '-y',
            silenceFile,
        ]

        console.log(`🔇 Creating ${paddingSeconds.toFixed(3)}s silence file`)
        await this.runFFmpeg(silenceArgs, 'addSilencePadding', paddingSeconds)

        // Create concat list with absolute paths (no escaping needed)
        const absoluteSilencePath = path.resolve(silenceFile)
        const absoluteInputPath = path.resolve(inputAudioPath)

        const concatContent = `file '${absoluteSilencePath}'
file '${absoluteInputPath}'`

        fs.writeFileSync(concatListFile, concatContent, 'utf8')
        console.log(`📝 Created concat list:`)
        console.log(`   - ${absoluteSilencePath}`)
        console.log(`   - ${absoluteInputPath}`)

        // Concatenate using concat demuxer with re-encoding for clean timestamps
        const concatArgs = [
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            concatListFile,
            '-c:a',
            'pcm_s16le', // Re-encode instead of copy to ensure clean timestamps
            '-ar',
            AUDIO_SAMPLE_RATE.toString(),
            '-ac',
            '1',
            '-y',
            outputAudioPath,
        ]

        console.log(
            `🔇 Concatenating with demuxer (re-encoding for clean timestamps)`,
        )
        await this.runFFmpeg(concatArgs, 'addSilencePadding', paddingSeconds)

        // Cleanup temp files
        if (fs.existsSync(silenceFile)) {
            fs.unlinkSync(silenceFile)
        }
        if (fs.existsSync(concatListFile)) {
            fs.unlinkSync(concatListFile)
        }
    }

    private async trimAudioStart(
        inputAudioPath: string,
        outputAudioPath: string,
        trimSeconds: number,
    ): Promise<void> {
        const args = [
            '-i',
            inputAudioPath,
            '-ss',
            trimSeconds.toString(),
            '-c:a',
            'pcm_s16le', // Re-encode instead of copy to ensure clean timestamps
            '-ar',
            AUDIO_SAMPLE_RATE.toString(),
            '-ac',
            '1',
            '-avoid_negative_ts',
            'make_zero',
            '-y',
            outputAudioPath,
        ]

        console.log(
            `✂️ Trimming ${trimSeconds.toFixed(3)}s from audio start (re-encoding for clean timestamps)`,
        )
        await this.runFFmpeg(args, 'trimAudioStart', trimSeconds)
    }

    private async mergeWithSync(
        videoPath: string,
        audioPath: string,
        outputPath: string,
    ): Promise<void> {
        const args = [
            '-i',
            videoPath,
            '-i',
            audioPath,
            '-c:v',
            'copy', // Ultra-fast copy - video already has frequent keyframes from recording
            '-c:a',
            'aac', // Convert to AAC during merge to avoid re-encoding later
            '-b:a',
            AUDIO_BITRATE,
            '-shortest',
            '-avoid_negative_ts',
            'make_zero',
            '-y',
            outputPath,
        ]

        console.log(
            `🎬 Merging video and audio (ultra-fast copy + AAC audio - keyframes already optimized)`,
        )

        // Estimate file size for timeout calculation
        const videoSizeMB = this.estimateFileSizeMB(videoPath)
        const audioSizeMB = this.estimateFileSizeMB(audioPath)
        const estimatedSizeMB = videoSizeMB + audioSizeMB

        await this.runFFmpeg(args, 'mergeWithSync', estimatedSizeMB)
    }

    private async finalTrimFromOffset(
        inputPath: string,
        outputPath: string,
        calcOffset: number,
        duration: number,
    ): Promise<void> {
        // Now we can use ultra-fast copy mode since the merged file has frequent keyframes
        // The video was re-encoded during merge with keyframes every 1 second
        const args = [
            '-i',
            inputPath,
            '-ss',
            calcOffset.toString(),
            '-t',
            duration.toString(),
            '-c:v',
            'copy', // Ultra-fast copy mode - no keyframe issues thanks to frequent keyframes
            '-c:a',
            'copy', // Copy audio stream since it's already AAC
            '-movflags',
            '+faststart',
            '-avoid_negative_ts',
            'make_zero',
            '-y',
            outputPath,
        ]

        console.log(
            `✂️ Final trim: ultra-fast copy mode ${duration.toFixed(2)}s from ${calcOffset.toFixed(3)}s (frequent keyframes = no freeze)`,
        )

        // Estimate file size for timeout calculation
        const estimatedSizeMB = this.estimateFileSizeMB(inputPath)

        await this.runFFmpeg(args, 'finalTrimFromOffset', estimatedSizeMB)
    }

    private async extractAudioFromVideo(
        videoPath: string,
        audioPath: string,
    ): Promise<void> {
        const args = [
            '-i',
            videoPath,
            '-vn',
            '-c:a',
            'pcm_s16le',
            '-ar',
            AUDIO_SAMPLE_RATE.toString(),
            '-ac',
            '1',
            '-y',
            audioPath,
        ]

        console.log(
            '🎵 Extracting audio from video (converting to WAV PCM 16kHz mono)',
        )

        // Estimate file size for timeout calculation
        const estimatedSizeMB = this.estimateFileSizeMB(videoPath)

        await this.runFFmpeg(args, 'extractAudioFromVideo', estimatedSizeMB)
    }

    private async createAudioChunks(audioPath: string): Promise<void> {
        if (!UPLOAD_AUDIO_CHUNKS) return

        const chunksDir = PathManager.getInstance().getAudioTmpPath()
        if (!fs.existsSync(chunksDir)) {
            fs.mkdirSync(chunksDir, { recursive: true })
        }

        // Get audio file size and duration
        let fileSizeBytes = 0
        let fileSizeMB = 'unknown'
        if (fs.existsSync(audioPath)) {
            const stats = fs.statSync(audioPath)
            fileSizeBytes = stats.size
            fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2)
        }

        // Get audio duration
        const duration = await this.getDuration(audioPath)
        const botUuid = GLOBAL.get().bot_uuid

        // Calculate chunk duration (max 1 hour = 3600 seconds)
        const chunkDuration = Math.min(duration, TRANSCRIPTION_CHUNK_DURATION)
        const chunkPattern = path.join(chunksDir, `${botUuid}-%d.wav`)

        const args = [
            '-i',
            audioPath,
            '-acodec',
            'pcm_s16le',
            '-ac',
            '1',
            '-ar',
            AUDIO_SAMPLE_RATE.toString(),
            '-f',
            'segment',
            '-segment_time',
            chunkDuration.toString(),
            '-segment_format',
            'wav',
            '-y',
            chunkPattern,
        ]

        console.log(
            `🎵 Creating audio chunks (${chunkDuration}s each) from ${duration.toFixed(1)}s audio`,
        )
        console.log(
            `📊 Audio file size: ${fileSizeMB} MB (${fileSizeBytes} bytes) | Duration: ${duration.toFixed(1)}s`,
        )
        try {
            // Estimate file size for timeout calculation
            const estimatedSizeMB = this.estimateFileSizeMB(audioPath)

            await this.runFFmpeg(args, 'createAudioChunks', estimatedSizeMB)
            // Upload created chunks
            await this.uploadAudioChunks(chunksDir, botUuid)
        } catch (error) {
            console.warn(
                `⚠️ Audio chunking failed (likely due to bot removal): ${error}`,
            )
            console.warn(
                `⚠️ Continuing without audio chunks to prevent bot hang`,
            )
            // Don't throw - allow cleanup to continue
        }
    }

    /**
     * Estimate file size in MB for timeout calculation
     */
    private estimateFileSizeMB(filePath: string): number {
        try {
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath)
                return Math.round(stats.size / (1024 * 1024))
            }
        } catch (error) {
            console.warn(
                'Could not estimate file size for timeout calculation:',
                error,
            )
        }
        return 100 // Default estimate
    }

    private async getDuration(filePath: string): Promise<number> {
        const args = [
            '-v',
            'quiet',
            '-show_entries',
            'format=duration',
            '-of',
            'csv=p=0',
            filePath,
        ]
        const result = await this.runFFprobe(args)
        return parseFloat(result.trim())
    }

    private async cleanupTempFiles(filePaths: string[]): Promise<void> {
        // for (const filePath of filePaths) {
        //     if (fs.existsSync(filePath)) {
        //         fs.unlinkSync(filePath)
        //         console.log(`🗑️ Cleaned up: ${path.basename(filePath)}`)
        //     }
        // }
    }

    private async runFFmpeg(
        args: string[],
        operation: string = 'unknown',
        fileSizeMB?: number,
    ): Promise<void> {
        const timeout = calculateFFmpegTimeout(operation, fileSizeMB)

        console.log(
            `⏱️ FFmpeg ${operation}: timeout set to ${timeout / 1000}s${fileSizeMB ? ` (estimated file size: ${fileSizeMB}MB)` : ''}`,
        )

        return new Promise((resolve, reject) => {
            const process = spawn('ffmpeg', args)
            let stderr = ''

            // Capture stderr for better error reporting
            process.stderr?.on('data', (data) => {
                stderr += data.toString()
            })

            process.on('close', (code) => {
                if (code === 0) {
                    resolve()
                } else {
                    // Provide more specific error information
                    const errorMsg = `FFmpeg failed with code ${code}`
                    const stderrPreview = stderr
                        .split('\n')
                        .slice(-3)
                        .join('\n') // Last 3 lines
                    console.error(`❌ ${errorMsg}`)
                    if (stderrPreview) {
                        console.error(`❌ FFmpeg stderr: ${stderrPreview}`)
                    }
                    reject(new Error(errorMsg))
                }
            })

            process.on('error', (error) => {
                console.error(`❌ FFmpeg process error: ${error.message}`)
                reject(error)
            })

            // Add dynamic timeout to prevent hanging
            const timeoutId = setTimeout(() => {
                console.error(
                    `❌ FFmpeg timeout after ${timeout / 1000}s for ${operation}, killing process`,
                )
                process.kill('SIGKILL')
                reject(new Error(`FFmpeg timeout for ${operation}`))
            }, timeout)

            process.on('close', () => {
                clearTimeout(timeoutId)
            })
        })
    }

    private async runFFprobe(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const process = spawn('ffprobe', args)
            let output = ''

            process.stdout?.on('data', (data) => {
                output += data.toString()
            })

            process.on('close', (code) => {
                if (code === 0) {
                    resolve(output)
                } else {
                    reject(new Error(`FFprobe failed with code ${code}`))
                }
            })

            process.on('error', (error) => {
                reject(error)
            })

            // Add timeout for metadata operations
            const timeoutId = setTimeout(() => {
                console.error(`❌ FFprobe timeout after 30s, killing process`)
                process.kill('SIGKILL')
                reject(new Error('FFprobe timeout'))
            }, 30000)

            process.on('close', () => {
                clearTimeout(timeoutId)
            })
        })
    }
}

export class ScreenRecorderManager {
    private static instance: ScreenRecorder

    public static getInstance(): ScreenRecorder {
        if (!ScreenRecorderManager.instance) {
            ScreenRecorderManager.instance = new ScreenRecorder()
        }
        return ScreenRecorderManager.instance
    }
}
