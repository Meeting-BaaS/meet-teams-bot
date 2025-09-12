import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { Streaming } from '../streaming'

import { Page } from 'playwright'
import { GLOBAL } from '../singleton'
import { MeetingEndReason } from '../state-machine/types'

import { HtmlSnapshotService } from '../services/html-snapshot-service'
import { calculateVideoOffset } from '../utils/CalculVideoOffset'
import { PathManager } from '../utils/PathManager'
import { S3Uploader } from '../utils/S3Uploader'
import { sleep } from '../utils/sleep'
import { generateSyncSignal } from '../utils/SyncSignal'

const TRANSCRIPTION_CHUNK_DURATION = 3600
const GRACE_PERIOD_SECONDS = 3
const STREAMING_SAMPLE_RATE = 24_000
const AUDIO_SAMPLE_RATE = 44_100 // Improved audio quality
const AUDIO_BITRATE = '192k' // Improved audio bitrate
const FLASH_SCREEN_SLEEP_TIME = 4500 // Increased from 4200 for better stability in prod
const SCREENSHOT_PERIOD = 5 // every 5 seconds instead of 2
const SCREENSHOT_WIDTH = 480 // reduced for smaller file size
const SCREENSHOT_HEIGHT = 270 // reduced for smaller file size (16:9 ratio)

// Environment variables for display and virtual speaker monitor
const DISPLAY = process.env.DISPLAY || ':99'
const VIRTUAL_SPEAKER_MONITOR =
    process.env.VIRTUAL_SPEAKER_MONITOR || 'virtual_speaker.monitor'

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
    private outputPath: string = ''
    private audioOutputPath: string = ''
    private config: ScreenRecordingConfig
    private isRecording: boolean = false
    private filesUploaded: boolean = false
    private recordingStartTime: number = 0
    private meetingStartTime: number = 0
    private gracePeriodActive: boolean = false

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
            if (GLOBAL.get().recording_mode === 'audio_only') {
                this.audioOutputPath =
                    PathManager.getInstance().getOutputPath() + '.wav'
            } else {
                this.outputPath =
                    PathManager.getInstance().getOutputPath() + '.mp4'
                this.audioOutputPath =
                    PathManager.getInstance().getOutputPath() + '.wav'
            }
        } catch (error) {
            console.error('Failed to generate output paths:', error)
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
            this.setupProcessMonitoring()
            this.setupStreamingAudio()

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
            console.error('Failed to start native recording:', error)
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
            console.error('❌ FFmpeg audio test failed:', error)
        }

        throw new Error(
            `Audio devices not ready after maximum wait time - ${VIRTUAL_SPEAKER_MONITOR} unavailable`,
        )
    }

    private buildNativeFFmpegArgs(): string[] {
        const args: string[] = []

        console.log(
            '🛠️ Building FFmpeg args for separate audio/video recording...',
        )

        const screenshotsPath = PathManager.getInstance().getScreenshotsPath()
        const timestamp = Date.now()
        const screenshotPattern = path.join(
            screenshotsPath,
            `${timestamp}_%4d.png`,
        )

        if (GLOBAL.get().recording_mode === 'audio_only') {
            // Audio-only recording with screenshots
            const tempDir = PathManager.getInstance().getTempPath()
            const rawAudioPath = path.join(tempDir, 'raw.wav')

            args.push(
                // === AUDIO INPUT ===
                '-f',
                'pulse',
                '-thread_queue_size',
                '2048', // Increased from 1024 for better buffering
                '-i',
                VIRTUAL_SPEAKER_MONITOR,

                // === VIDEO INPUT FOR SCREENSHOTS ===
                '-f',
                'x11grab',
                '-video_size',
                '1280x880',
                '-framerate',
                '30',
                '-i',
                this.config.display,

                // === OUTPUT 1: RAW AUDIO ===
                '-map',
                '0:a:0',
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
                rawAudioPath,

                // === OUTPUT 2: SCREENSHOTS (every 5 seconds) ===
                '-map',
                '1:v:0',
                '-vf',
                `fps=${1 / SCREENSHOT_PERIOD},crop=1280:720:0:160,scale=${SCREENSHOT_WIDTH}:${SCREENSHOT_HEIGHT}`,
                '-q:v',
                '3', // High quality JPEG compression
                '-f',
                'image2',
                '-y',
                screenshotPattern,

                // === OUTPUT 3: STREAMING AUDIO ===
                '-map',
                '0:a:0',
                '-acodec',
                'pcm_f32le',
                '-ac',
                '1',
                '-ar',
                STREAMING_SAMPLE_RATE.toString(),
                '-f',
                'f32le',
                'pipe:1',
            )
        } else {
            // Separate audio and video recording
            const tempDir = PathManager.getInstance().getTempPath()
            const rawVideoPath = path.join(tempDir, 'raw.mp4')
            const rawAudioPath = path.join(tempDir, 'raw.wav')

            args.push(
                // === VIDEO INPUT ===
                '-f',
                'x11grab',
                '-video_size',
                '1280x880',
                '-framerate',
                '30',
                '-i',
                this.config.display,

                // === AUDIO INPUT ===
                '-f',
                'pulse',
                '-thread_queue_size',
                '2048', // Increased from 1024 for better buffering
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
                'crop=1280:720:0:160',
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
                rawAudioPath,

                // === OUTPUT 3: SCREENSHOTS (every 5 seconds) ===
                '-map',
                '0:v:0',
                '-vf',
                `fps=${1 / SCREENSHOT_PERIOD},crop=1280:720:0:160,scale=${SCREENSHOT_WIDTH}:${SCREENSHOT_HEIGHT}`,
                '-q:v',
                '3', // High quality JPEG compression
                '-f',
                'image2',
                '-y',
                screenshotPattern,

                // === OUTPUT 4: STREAMING AUDIO ===
                '-map',
                '1:a:0',
                '-acodec',
                'pcm_f32le',
                '-ac',
                '1',
                '-ar',
                STREAMING_SAMPLE_RATE.toString(),
                '-f',
                'f32le',
                'pipe:1',
            )
        }

        return args
    }

    private setupProcessMonitoring(): void {
        if (!this.ffmpegProcess) return

        this.ffmpegProcess.on('error', (error) => {
            console.error('FFmpeg error:', error)
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
            this.emit('stopped')
        })

        // Enhanced error monitoring for PulseAudio issues
        let errorCount = 0
        const maxErrors = 10 // Increased from 5 to be less aggressive
        const errorWindowMs = 60000 // Increased to 60 seconds for better tolerance
        let lastErrorTime = 0
        const errorCooldownMs = 5000 // 5 second cooldown between error handling

        this.ffmpegProcess.stderr?.on('data', (data) => {
            const output = data.toString()
            const outputLower = output.toLowerCase()
            if (outputLower.includes('error')) {
                console.error('FFmpeg stderr:', output.trim())

                // Check for specific PulseAudio errors that indicate audio input failure
                if (
                    outputLower.includes('error during demuxing') ||
                    outputLower.includes(
                        'error retrieving a packet from demuxer',
                    ) ||
                    outputLower.includes('generic error in an external library')
                ) {
                    const now = Date.now()
                    errorCount++
                    console.warn(
                        `⚠️ PulseAudio error detected (${errorCount}/${maxErrors})`,
                    )

                    // Only handle errors if enough time has passed since last handling
                    if (
                        errorCount >= maxErrors &&
                        now - lastErrorTime > errorCooldownMs
                    ) {
                        lastErrorTime = now
                        console.warn(
                            '⚠️ Multiple PulseAudio errors detected, continuing recording...',
                        )

                        // Emit a warning event for monitoring purposes
                        const audioWarning: AudioWarningEvent = {
                            type: 'pulseAudioWarning',
                            errorCount,
                            message:
                                'PulseAudio input stream experiencing issues - continuing recording',
                            timestamp: Date.now(),
                        }
                        this.emit('audioWarning', audioWarning)

                        // Don't reset error count immediately - let it accumulate
                    }
                }
            }
        })

        // Reset error count periodically but less frequently
        setInterval(() => {
            if (errorCount > 0) {
                console.log(
                    `🔄 Resetting PulseAudio error count (was ${errorCount})`,
                )
                errorCount = 0
                lastErrorTime = 0
            }
        }, errorWindowMs)
    }

    private setupStreamingAudio(): void {
        if (!Streaming.instance || !this.ffmpegProcess) return

        try {
            this.ffmpegProcess.stdout?.on('data', (data: Buffer) => {
                try {
                    if (Streaming.instance) {
                        const float32Array = new Float32Array(
                            data.buffer,
                            data.byteOffset,
                            data.length / 4,
                        )
                        Streaming.instance.processAudioChunk(float32Array)
                    }
                } catch (error) {
                    console.error('Failed to process audio chunk:', error)
                    // Don't throw - continue processing other chunks
                }
            })
        } catch (error) {
            console.error('Failed to setup streaming audio:', error)
        }
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
                    console.error(`Failed to upload chunk ${filename}:`, error)
                }
            }
        } catch (error) {
            console.error('Failed to read chunks directory:', error)
        }
    }

    public async uploadToS3(): Promise<void> {
        if (this.filesUploaded || !S3Uploader.getInstance()) {
            return
        }

        const identifier = PathManager.getInstance().getIdentifier()

        try {
            if (fs.existsSync(this.audioOutputPath)) {
                console.log(
                    `📤 Uploading WAV audio to video bucket: ${GLOBAL.get().remote?.aws_s3_video_bucket}`,
                )
                await S3Uploader.getInstance().uploadFile(
                    this.audioOutputPath,
                    GLOBAL.get().remote?.aws_s3_video_bucket!,
                    `${identifier}.wav`,
                )
                fs.unlinkSync(this.audioOutputPath)
            }
        } catch (error) {
            console.error('Failed to upload audio file:', error)
            // Don't throw - continue with video upload
        }

        try {
            if (fs.existsSync(this.outputPath)) {
                console.log(
                    `📤 Uploading MP4 to video bucket: ${GLOBAL.get().remote?.aws_s3_video_bucket}`,
                )
                await S3Uploader.getInstance().uploadFile(
                    this.outputPath,
                    GLOBAL.get().remote?.aws_s3_video_bucket!,
                    `${identifier}.mp4`,
                )
                fs.unlinkSync(this.outputPath)
            }
        } catch (error) {
            console.error('Failed to upload video file:', error)
            // Don't throw - mark as uploaded to allow process completion
        }

        this.filesUploaded = true
    }

    public async stopRecording(): Promise<void> {
        if (!this.isRecording || !this.ffmpegProcess) {
            return
        }

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
                this.ffmpegProcess = null
                resolve()
            })

            this.once('error', (error) => {
                console.error(
                    'ScreenRecorder error during stop:',
                    error instanceof Error ? error.message : error,
                )
                this.gracePeriodActive = false
                this.ffmpegProcess = null
                reject(error)
            })

            // Send graceful termination signal
            this.ffmpegProcess!.kill('SIGINT')

            // Fallback force kill after timeout
            setTimeout(() => {
                if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
                    console.warn('⚠️ Force killing FFmpeg process')
                    this.ffmpegProcess.kill('SIGKILL')
                }
            }, 8000)
        })
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
                    console.error('❌ Upload failed:', error)
                }
            }
        } catch (error) {
            console.error('❌ Error during recording processing:', error)

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
        if (GLOBAL.get().recording_mode === 'audio_only') {
            // Audio-only mode: just copy raw audio to final output
            const tempDir = PathManager.getInstance().getTempPath()
            const rawAudioPath = path.join(tempDir, 'raw.wav')

            console.log('🔄 Processing audio-only recording...')

            if (fs.existsSync(rawAudioPath)) {
                // Copy raw audio to final output location
                fs.copyFileSync(rawAudioPath, this.audioOutputPath)
                console.log(`✅ Audio copied to: ${this.audioOutputPath}`)

                // Create audio chunks from the final audio file
                await this.createAudioChunks(this.audioOutputPath)
            } else {
                console.error('❌ Raw audio file not found:', rawAudioPath)
            }

            console.log('✅ Audio-only processing completed')
            return
        }

        // Video mode: efficient sync and merge process for long recordings
        const tempDir = PathManager.getInstance().getTempPath()
        const rawVideoPath = path.join(tempDir, 'raw.mp4')
        const rawAudioPath = path.join(tempDir, 'raw.wav')

        console.log(
            '🔄 Starting efficient sync and merge for long recording...',
        )

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

        // 7. Extract audio from the final trimmed video (ensures perfect sync)
        try {
            await this.extractAudioFromVideo(
                this.outputPath,
                this.audioOutputPath,
            )
            console.log(
                `✅ Audio extracted from final video: ${this.audioOutputPath}`,
            )

            // 8. Create audio chunks from the extracted audio
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

        // 9. Cleanup temporary files
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
        if (!GLOBAL.get().speech_to_text_provider) return

        const chunksDir = PathManager.getInstance().getAudioTmpPath()
        if (!fs.existsSync(chunksDir)) {
            fs.mkdirSync(chunksDir, { recursive: true })
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
