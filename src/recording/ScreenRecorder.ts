import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { Streaming } from '../streaming'

import { GLOBAL } from '../singleton'
import { PathManager } from '../utils/PathManager'
import { S3Uploader } from '../utils/S3Uploader'
import { SyncCalibrator } from './SyncCalibrator'

interface ScreenRecordingConfig {
    audioDevice?: string
    audioCodec: 'aac' | 'opus' | 'libmp3lame'
    audioBitrate: string
    enableTranscriptionChunking?: boolean
    transcriptionChunkDuration?: number
    s3Path?: string
    // Grace period settings for clean endings
    gracePeriodSeconds?: number
    trimEndSeconds?: number
}

export class ScreenRecorder extends EventEmitter {
    private ffmpegProcess: ChildProcess | null = null
    private chunkWatcher: fs.FSWatcher | null = null
    private streamingProcess: ChildProcess | null = null
    private outputPath: string = ''
    private audioOutputPath: string = ''
    private config: ScreenRecordingConfig
    private s3Uploader: S3Uploader | null = null
    private isConfigured: boolean = false
    private isRecording: boolean = false
    private filesUploaded: boolean = false
    private recordingStartTime: number = 0
    private syncCalibrator: SyncCalibrator
    private pathManager: PathManager | null = null
    private page: any = null
    private gracePeriodActive: boolean = false

    constructor(config: Partial<ScreenRecordingConfig> = {}) {
        super()

        this.config = {
            audioDevice: 'pulse',
            audioCodec: 'aac',
            audioBitrate: '128k',
            enableTranscriptionChunking: false,
            transcriptionChunkDuration: 3600,
            s3Path: '',
            // Default grace period: 3s recording + 2s trim = clean ending
            gracePeriodSeconds: 3,
            trimEndSeconds: 2,
            ...config,
        }

        this.syncCalibrator = new SyncCalibrator()

        if (!GLOBAL.isServerless()) {
            this.s3Uploader = S3Uploader.getInstance()
        }

        console.log('Native ScreenRecorder initialized:', {
            enableTranscriptionChunking:
                this.config.enableTranscriptionChunking,
        })
    }

    public configure(
        pathManager: PathManager,
    ): void {
        if (!pathManager) {
            throw new Error('PathManager is required for configuration')
        }

        this.pathManager = pathManager

        // Simple transcription detection
        if (GLOBAL.get().speech_to_text_provider) {
            this.config.enableTranscriptionChunking =
                GLOBAL.get().speech_to_text_provider !== null
        }

        // Native path generation (no legacy patterns)
        this.generateOutputPaths(pathManager)

        // Simple S3 configuration
        const { s3Path } = pathManager.getS3Paths()
        this.config.s3Path = s3Path

        this.isConfigured = true

        console.log('Native ScreenRecorder configured:', {
            outputPath: this.outputPath,
            audioOutputPath: this.audioOutputPath,
        })
    }

    private generateOutputPaths(pathManager: PathManager): void {
        if (GLOBAL.get().recording_mode === 'audio_only') {
            this.audioOutputPath = pathManager.getOutputPath() + '.wav'
        } else {
            this.outputPath = pathManager.getOutputPath() + '.mp4'
            this.audioOutputPath = pathManager.getOutputPath() + '.wav'
        }
    }

    public setPage(page: any): void {
        this.page = page
    }

    /**
     * Retrieve the Playwright video file and prepare it for synchronization
     */
    public async retrievePlaywrightVideo(): Promise<string | null> {
        if (!this.page) {
            console.warn('No page available to retrieve video')
            return null
        }

        try {
            // Get the video file path from Playwright
            const videoPath = await this.page.video()?.path()
            
            if (!videoPath || !fs.existsSync(videoPath)) {
                console.warn('No video file found from Playwright')
                return null
            }

            console.log(`📹 Playwright video found: ${videoPath}`)
            return videoPath
        } catch (error) {
            console.error('Error retrieving Playwright video:', error)
            return null
        }
    }

    /**
     * Synchronize and merge Playwright video with system audio
     */
    public async mergeVideoWithAudio(playwrightVideoPath: string): Promise<void> {
        if (!this.audioOutputPath || !fs.existsSync(this.audioOutputPath)) {
            console.warn('No audio file available for merging')
            return
        }

        if (!fs.existsSync(playwrightVideoPath)) {
            console.warn('Playwright video file not found for merging')
            return
        }

        try {
            console.log('🎬 Starting video-audio synchronization and merging...')
            
            // Calculate sync offset using existing method
            const syncOffset = await this.calculateSyncOffset()
            
            // Create final output path
            const finalOutputPath = this.pathManager?.getOutputPath() + '.mp4'
            
            if (!finalOutputPath) {
                throw new Error('No output path available for final video')
            }

            // Build FFmpeg args for merging with sync
            const mergeArgs = this.buildMergeArgs(playwrightVideoPath, syncOffset, finalOutputPath)
            
            console.log('🔄 Merging video and audio with synchronization...')
            
            return new Promise((resolve, reject) => {
                const mergeProcess = spawn('ffmpeg', mergeArgs, {
                    stdio: ['pipe', 'pipe', 'pipe']
                })

                mergeProcess.on('error', (error) => {
                    console.error('FFmpeg merge error:', error)
                    reject(error)
                })

                mergeProcess.on('exit', (code) => {
                    if (code === 0) {
                        console.log('✅ Video-audio merge completed successfully')
                        
                        // Clean up individual files
                        this.cleanupIndividualFiles(playwrightVideoPath)
                        
                        // Update output path to final merged file
                        this.outputPath = finalOutputPath
                        
                        resolve()
                    } else {
                        console.error(`❌ FFmpeg merge failed with code ${code}`)
                        reject(new Error(`FFmpeg merge failed with code ${code}`))
                    }
                })

                mergeProcess.stderr?.on('data', (data) => {
                    const output = data.toString()
                    if (output.includes('error')) {
                        console.error('FFmpeg merge stderr:', output.trim())
                    }
                })
            })
        } catch (error) {
            console.error('Error merging video with audio:', error)
            throw error
        }
    }

    /**
     * Build FFmpeg arguments for merging video and audio with synchronization
     */
    private buildMergeArgs(playwrightVideoPath: string, syncOffset: number, finalOutputPath: string): string[] {
        const args: string[] = []

        // Input 1: Playwright video (no offset needed, it's the reference)
        args.push('-i', playwrightVideoPath)
        
        // Input 2: System audio (with sync offset)
        args.push(
            '-itsoffset', syncOffset.toString(),
            '-i', this.audioOutputPath
        )

        // Output configuration
        args.push(
            // Map video from first input
            '-map', '0:v:0',
            // Map audio from second input
            '-map', '1:a:0',
            // Video codec (copy to avoid re-encoding)
            '-c:v', 'copy',
            // Audio codec
            '-c:a', 'aac',
            // Audio bitrate
            '-b:a', '160k',
            // Avoid negative timestamps
            '-avoid_negative_ts', 'make_zero',
            // Output format
            '-f', 'mp4',
            // Output file
            '-y', finalOutputPath
        )

        console.log(`🎯 Merge args: video + audio with ${syncOffset.toFixed(3)}s offset`)
        return args
    }

    /**
     * Clean up individual video and audio files after successful merge
     */
    private cleanupIndividualFiles(playwrightVideoPath: string): void {
        try {
            // Remove Playwright video file
            if (fs.existsSync(playwrightVideoPath)) {
                fs.unlinkSync(playwrightVideoPath)
                console.log('🗑️ Cleaned up Playwright video file')
            }
            
            // Remove audio file (already handled by upload process)
            console.log('🗑️ Audio file will be cleaned up by upload process')
        } catch (error) {
            console.warn('Warning: Could not clean up individual files:', error)
        }
    }

    public async startRecording(): Promise<void> {
        this.validateConfiguration()

        if (this.isRecording) {
            throw new Error('Recording is already in progress')
        }

        console.log('🎬 Starting native recording...')

        try {
            await this.ensureOutputDirectory()
            const syncOffset = await this.calculateSyncOffset()
            const ffmpegArgs = this.buildNativeFFmpegArgs(syncOffset)

            this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            this.isRecording = true
            this.recordingStartTime = Date.now()
            this.gracePeriodActive = false
            this.setupProcessMonitoring()
            this.startNativeAudioStreaming()

            console.log('Native recording started successfully')
            this.emit('started', {
                outputPath: this.outputPath,
                isAudioOnly: GLOBAL.get().recording_mode === 'audio_only',
            })
        } catch (error) {
            console.error('Failed to start native recording:', error)
            this.isRecording = false
            this.emit('error', { type: 'startError', error })
            throw error
        }
    }

    private validateConfiguration(): void {
        if (!this.isConfigured) {
            throw new Error('ScreenRecorder must be configured before starting')
        }
    }

    private async ensureOutputDirectory(): Promise<void> {
        const outputDir = path.dirname(this.outputPath)
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true })
        }
    }

    private async calculateSyncOffset(): Promise<number> {
        // Native sync calculation (simplified)
        const systemLoad = await this.getSystemLoad()
        const roughEstimate = this.estimateOffsetFromLoad(systemLoad)

        if (this.page) {
            try {
                const preciseOffset =
                    await this.syncCalibrator.quickCalibrateOnceOptimized(
                        this.page,
                    )
                if (Math.abs(preciseOffset) > 0.001) {
                    return -preciseOffset + 0.02
                }
            } catch (error) {
                console.warn(
                    'Precise calibration failed, using system estimate',
                )
            }
        }

        return roughEstimate
    }

    private buildNativeFFmpegArgs(syncOffset: number): string[] {
        const args: string[] = []
        const isAudioOnly = GLOBAL.get().recording_mode === 'audio_only'

        console.log('🛠️ Building FFmpeg args for audio-only recording...')
        console.log(`🎯 Applying audio offset: ${syncOffset.toFixed(3)}s`)

        // Audio input - auto-detect PulseAudio config
        args.push(
            '-f',
            'pulse',
            '-itsoffset',
            syncOffset.toString(),
            '-i',
            'virtual_speaker.monitor',
        )

        // === OUTPUT 1: WAV (audio for transcription) ===
        args.push(
            '-acodec',
            'pcm_s16le',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-async',
            '1',
            '-avoid_negative_ts',
            'make_zero',
            '-f',
            'wav',
            this.audioOutputPath,
        )

        // === OUTPUT 2: Real-time chunks (if enabled) ===
        if (this.config.enableTranscriptionChunking) {
            // Use audio_tmp directory and UUID-based naming like production
            const chunksDir = this.pathManager
                ? this.pathManager.getAudioTmpPath()
                : path.join(path.dirname(this.audioOutputPath), 'audio_tmp')
            if (!fs.existsSync(chunksDir)) {
                fs.mkdirSync(chunksDir, { recursive: true })
            }

            // Use botUuid for chunk naming format: ${botUuid}-%d.wav
            const botUuid = GLOBAL.get().bot_uuid
            const chunkPattern = path.join(chunksDir, `${botUuid}-%d.wav`)

            args.push(
                '-vn',
                '-acodec',
                'pcm_s16le',
                '-ac',
                '1',
                '-ar',
                '16000',
                '-f',
                'segment',
                '-segment_time',
                (this.config.transcriptionChunkDuration || 3600).toString(),
                '-segment_format',
                'wav',
                chunkPattern,
            )

            this.startChunkMonitoring(chunksDir)
            console.log(
                `🎯 Real-time chunks: ${this.config.transcriptionChunkDuration}s chunks enabled`,
            )
            console.log(`🎯 Chunk naming format: ${botUuid}-[index].wav`)
        }

        console.log(
            `✅ FFmpeg itsoffset parameter: ${syncOffset.toFixed(3)}s`,
        )
        console.log(
            `🎯 Audio-only recording: WAV + chunks during recording`,
        )

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
                await this.handleSuccessfulRecording()
            } else {
                console.warn(
                    `⚠️ Recording failed - unexpected exit code: ${code}`,
                )
            }

            this.isRecording = false
            this.emit('stopped')
        })

        this.ffmpegProcess.stderr?.on('data', (data) => {
            const output = data.toString()
            if (output.includes('error')) {
                console.error('FFmpeg stderr:', output.trim())
            }
        })
    }

    private startNativeAudioStreaming(): void {
        if (!Streaming.instance) return

        try {
            const STREAMING_SAMPLE_RATE = 24_000

            this.streamingProcess = spawn(
                'ffmpeg',
                [
                    '-f',
                    'pulse',
                    '-i',
                    'virtual_speaker.monitor',
                    '-acodec',
                    'pcm_f32le',
                    '-ac',
                    '1',
                    '-ar',
                    STREAMING_SAMPLE_RATE.toString(),
                    '-f',
                    'f32le',
                    'pipe:1',
                ],
                { stdio: ['pipe', 'pipe', 'pipe'] },
            )

            this.streamingProcess.stdout?.on('data', (data: Buffer) => {
                if (Streaming.instance) {
                    const float32Array = new Float32Array(
                        data.buffer,
                        data.byteOffset,
                        data.length / 4,
                    )
                    Streaming.instance.processAudioChunk(float32Array)
                }
            })

            this.ffmpegProcess?.once('exit', () => {
                if (this.streamingProcess && !this.streamingProcess.killed) {
                    this.streamingProcess.kill('SIGINT')
                }
            })
        } catch (error) {
            console.error('Failed to start native audio streaming:', error)
        }
    }

    private startChunkMonitoring(chunksDir: string): void {
        this.chunkWatcher = fs.watch(chunksDir, async (eventType, filename) => {
            if (eventType === 'rename' && filename?.endsWith('.wav')) {
                const chunkPath = path.join(chunksDir, filename)
                setTimeout(
                    () => this.verifyAndUploadChunk(chunkPath, filename),
                    5000,
                )
            }
        })
    }

    private async verifyAndUploadChunk(
        chunkPath: string,
        filename: string,
    ): Promise<void> {
        if (!this.s3Uploader || !fs.existsSync(chunkPath)) {
            console.warn(`Chunk file not found: ${chunkPath}`)
            return
        }

        try {
            // Verify the file has content before uploading
            const stats = fs.statSync(chunkPath)
            if (stats.size === 0) {
                console.warn(`Chunk file is empty, waiting longer: ${filename}`)
                // Wait additional time for FFmpeg to finish writing
                setTimeout(
                    () => this.verifyAndUploadChunk(chunkPath, filename),
                    3000,
                )
                return
            }

            // Double-check file stability (size not changing)
            await new Promise((resolve) => setTimeout(resolve, 1000))
            const newStats = fs.statSync(chunkPath)
            if (newStats.size !== stats.size) {
                console.log(`Chunk still being written, waiting: ${filename}`)
                setTimeout(
                    () => this.verifyAndUploadChunk(chunkPath, filename),
                    2000,
                )
                return
            }

            console.log(
                `📤 Uploading complete chunk: ${filename} (${stats.size} bytes)`,
            )

            const botUuid = GLOBAL.get().bot_uuid || 'unknown'
            const s3Key = `${botUuid}/${filename}`

            await this.s3Uploader.uploadFile(
                chunkPath,
                GLOBAL.get().aws_s3_temporary_audio_bucket,
                s3Key,
                [],
                true,
            )

            console.log(`✅ Chunk uploaded successfully: ${filename}`)
        } catch (error) {
            console.error(`Failed to upload chunk ${filename}:`, error)
        }
    }

    private cleanupChunkMonitoring(): void {
        if (this.chunkWatcher) {
            this.chunkWatcher.close()
            this.chunkWatcher = null
        }
    }

    /**
     * Post-process recordings to remove corrupted endings
     * Creates trimmed copies and replaces originals
     */
    private async postProcessRecordings(): Promise<void> {
        const trimSeconds = this.config.trimEndSeconds || 2

        console.log(
            `🔧 Post-processing: trimming last ${trimSeconds}s to remove corruption`,
        )

        try {
            if (GLOBAL.get().recording_mode === 'audio_only') {
                // Audio-only mode: trim WAV file
                await this.trimAudioFile(this.audioOutputPath, trimSeconds)
            } else {
                // Video mode: trim both MP4 and WAV files
                await Promise.all([
                    this.trimVideoFile(this.outputPath, trimSeconds),
                    this.trimAudioFile(this.audioOutputPath, trimSeconds),
                ])
            }

            console.log('✅ Post-processing completed - clean endings applied')
        } catch (error) {
            console.error(
                '⚠️ Post-processing failed, keeping original files:',
                error,
            )
        }
    }

    /**
     * Trim end of MP4 video file using FFmpeg
     */
    private async trimVideoFile(
        filePath: string,
        trimSeconds: number,
    ): Promise<void> {
        if (!fs.existsSync(filePath)) {
            console.warn(`Video file not found for trimming: ${filePath}`)
            return
        }

        const tempPath = filePath + '.trimmed.mp4'

        return new Promise((resolve, reject) => {
            // Get video duration first, then calculate trim duration
            const durationProcess = spawn('ffprobe', [
                '-v',
                'quiet',
                '-show_entries',
                'format=duration',
                '-of',
                'csv=p=0',
                filePath,
            ])

            let durationOutput = ''
            durationProcess.stdout?.on('data', (data) => {
                durationOutput += data.toString()
            })

            durationProcess.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error('Failed to get video duration'))
                    return
                }

                const duration = parseFloat(durationOutput.trim())
                const trimmedDuration = Math.max(1, duration - trimSeconds) // Minimum 1 second

                console.log(
                    `📹 Trimming MP4: ${duration.toFixed(1)}s → ${trimmedDuration.toFixed(1)}s`,
                )

                // Trim the video
                const trimProcess = spawn('ffmpeg', [
                    '-i',
                    filePath,
                    '-t',
                    trimmedDuration.toString(),
                    '-c',
                    'copy', // Copy streams without re-encoding for speed
                    '-avoid_negative_ts',
                    'make_zero',
                    '-y',
                    tempPath,
                ])

                trimProcess.on('close', (trimCode) => {
                    if (trimCode === 0 && fs.existsSync(tempPath)) {
                        // Replace original with trimmed version
                        fs.renameSync(tempPath, filePath)
                        resolve()
                    } else {
                        // Cleanup temp file if it exists
                        if (fs.existsSync(tempPath)) {
                            fs.unlinkSync(tempPath)
                        }
                        reject(
                            new Error(
                                `FFmpeg trim failed with code ${trimCode}`,
                            ),
                        )
                    }
                })
            })
        })
    }

    /**
     * Trim end of WAV audio file using FFmpeg
     */
    private async trimAudioFile(
        filePath: string,
        trimSeconds: number,
    ): Promise<void> {
        if (!fs.existsSync(filePath)) {
            console.warn(`Audio file not found for trimming: ${filePath}`)
            return
        }

        const tempPath = filePath + '.trimmed.wav'

        return new Promise((resolve, reject) => {
            // Get audio duration first
            const durationProcess = spawn('ffprobe', [
                '-v',
                'quiet',
                '-show_entries',
                'format=duration',
                '-of',
                'csv=p=0',
                filePath,
            ])

            let durationOutput = ''
            durationProcess.stdout?.on('data', (data) => {
                durationOutput += data.toString()
            })

            durationProcess.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error('Failed to get audio duration'))
                    return
                }

                const duration = parseFloat(durationOutput.trim())
                const trimmedDuration = Math.max(1, duration - trimSeconds) // Minimum 1 second

                console.log(
                    `🎵 Trimming WAV: ${duration.toFixed(1)}s → ${trimmedDuration.toFixed(1)}s`,
                )

                // Trim the audio
                const trimProcess = spawn('ffmpeg', [
                    '-i',
                    filePath,
                    '-t',
                    trimmedDuration.toString(),
                    '-c',
                    'copy', // Copy stream without re-encoding
                    '-y',
                    tempPath,
                ])

                trimProcess.on('close', (trimCode) => {
                    if (trimCode === 0 && fs.existsSync(tempPath)) {
                        // Replace original with trimmed version
                        fs.renameSync(tempPath, filePath)
                        resolve()
                    } else {
                        // Cleanup temp file if it exists
                        if (fs.existsSync(tempPath)) {
                            fs.unlinkSync(tempPath)
                        }
                        reject(
                            new Error(
                                `FFmpeg audio trim failed with code ${trimCode}`,
                            ),
                        )
                    }
                })
            })
        })
    }

    public async uploadToS3(): Promise<void> {
        if (this.filesUploaded || !this.s3Uploader) {
            return
        }

        const identifier = PathManager.getInstance().getIdentifier()

        // Upload audio file (always available)
        if (fs.existsSync(this.audioOutputPath)) {
            console.log(
                `📤 Uploading WAV audio to video bucket: ${GLOBAL.get().remote?.aws_s3_video_bucket}`,
            )
            await this.s3Uploader.uploadFile(
                this.audioOutputPath,
                GLOBAL.get().remote?.aws_s3_video_bucket!,
                `${identifier}.wav`,
            )
            fs.unlinkSync(this.audioOutputPath)
        }

        // Upload merged video file (if available)
        if (fs.existsSync(this.outputPath)) {
            console.log(
                `📤 Uploading merged MP4 to video bucket: ${GLOBAL.get().remote?.aws_s3_video_bucket}`,
            )
            await this.s3Uploader.uploadFile(
                this.outputPath,
                GLOBAL.get().remote?.aws_s3_video_bucket!,
                `${identifier}.mp4`,
            )
            fs.unlinkSync(this.outputPath)
        }

        this.filesUploaded = true
    }

    public async stopRecording(): Promise<void> {
        if (!this.isRecording || !this.ffmpegProcess) {
            return
        }

        console.log('🛑 Stop recording requested - starting grace period...')
        this.gracePeriodActive = true

        const gracePeriodMs = (this.config.gracePeriodSeconds || 3) * 1000

        // Wait for grace period to allow clean ending
        console.log(
            `⏳ Grace period: ${this.config.gracePeriodSeconds}s for clean ending`,
        )

        await new Promise<void>((resolve) => {
            setTimeout(() => {
                console.log(
                    '✅ Grace period completed - stopping FFmpeg cleanly',
                )
                resolve()
            }, gracePeriodMs)
        })

        return new Promise((resolve) => {
            // Wait for the 'stopped' event instead of 'exit' to ensure upload is complete
            this.once('stopped', () => {
                this.gracePeriodActive = false
                this.ffmpegProcess = null
                resolve()
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
        isConfigured: boolean
        filesUploaded: boolean
        gracePeriodActive: boolean
        recordingDurationMs: number
    } {
        return {
            isRecording: this.isRecording,
            isConfigured: this.isConfigured,
            filesUploaded: this.filesUploaded,
            gracePeriodActive: this.gracePeriodActive,
            recordingDurationMs:
                this.recordingStartTime > 0
                    ? Date.now() - this.recordingStartTime
                    : 0,
        }
    }

    public getFilesUploaded(): boolean {
        return this.filesUploaded
    }

    // Helper methods
    private async getSystemLoad(): Promise<number> {
        try {
            const { exec } = require('child_process')
            const { promisify } = require('util')
            const execAsync = promisify(exec)

            const { stdout } = await execAsync('uptime')
            const loadMatch = stdout.match(/load average: ([\d.]+)/)
            return loadMatch ? parseFloat(loadMatch[1]) : 0
        } catch {
            return 0
        }
    }

    private estimateOffsetFromLoad(load: number): number {
        if (load < 1.5) return -0.065
        else if (load < 2.5) return 0.0
        else return -0.05
    }

    private async handleSuccessfulRecording(): Promise<void> {
        console.log('Audio recording completed')

        // Post-process audio file to remove corrupted endings
        await this.postProcessRecordings()

        // Retrieve and merge Playwright video with system audio
        if (GLOBAL.get().recording_mode !== 'audio_only') {
            try {
                console.log('🎬 Starting video-audio merge process...')
                
                // Retrieve Playwright video
                const playwrightVideoPath = await this.retrievePlaywrightVideo()
                
                if (playwrightVideoPath) {
                    // Merge video with audio using synchronization
                    await this.mergeVideoWithAudio(playwrightVideoPath)
                    console.log('✅ Video-audio merge completed')
                } else {
                    console.warn('⚠️ No Playwright video found, keeping audio-only recording')
                }
            } catch (error) {
                console.error('❌ Video-audio merge failed:', error)
                console.warn('⚠️ Continuing with audio-only recording')
            }
        }

        // Auto-upload if not serverless and wait for completion
        if (!GLOBAL.isServerless()) {
            try {
                await this.uploadToS3()
                console.log('✅ Upload completed successfully')
            } catch (error) {
                console.error('❌ Upload failed:', error)
            }
        }

        this.cleanupChunkMonitoring()
    }
}

export class ScreenRecorderManager {
    private static instance: ScreenRecorder

    public static getInstance(): ScreenRecorder {
        if (!ScreenRecorderManager.instance) {
            ScreenRecorderManager.instance = new ScreenRecorder({
                enableTranscriptionChunking:
                    GLOBAL.get().speech_to_text_provider !== null,
                transcriptionChunkDuration: 3600,
                // Clean endings by default
                gracePeriodSeconds: 3,
                trimEndSeconds: 2,
            })
        }
        return ScreenRecorderManager.instance
    }
}
