import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import { Streaming } from '../streaming'

import { Page } from 'playwright'
import { GLOBAL } from '../singleton'
import { calculateVideoOffset } from '../utils/CalculVideoOffset'
import { PathManager } from '../utils/PathManager'
import { S3Uploader } from '../utils/S3Uploader'
import { sleep } from '../utils/sleep'
import { generateSyncSignal } from '../utils/SyncSignal'

const GRACE_PERIOD_SECONDS = 3
const STREAMING_SAMPLE_RATE = 24_000
const AUDIO_OFFSET_COMPENSATION = 0.3 // 0.3 seconds compensation for large audio advance

export class ScreenRecorder extends EventEmitter {
    private ffmpegProcess: ChildProcess | null = null
    private outputPath: string = ''
    private audioOutputPath: string = ''
    private s3Uploader: S3Uploader | null = null
    private isRecording: boolean = false
    private filesUploaded: boolean = false
    private recordingStartTime: number = 0
    private meetingStartTime: number = 0 // Timestamp when the meeting actually started
    private page: Page
    private gracePeriodActive: boolean = false

    constructor() {
        super()

        if (!GLOBAL.isServerless()) {
            this.s3Uploader = S3Uploader.getInstance()
        }
    }
    private generateOutputPaths(pathManager: PathManager): void {
        if (GLOBAL.get().recording_mode === 'audio_only') {
            this.audioOutputPath = pathManager.getOutputPath() + '.wav'
        } else {
            this.outputPath = pathManager.getOutputPath() + '.mp4'
            this.audioOutputPath = pathManager.getOutputPath() + '.wav'
        }
    }

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

    public async startAudioRecording(page: Page): Promise<void> {
        if (this.isRecording) {
            throw new Error('Recording is already in progress')
        }

        this.generateOutputPaths(PathManager.getInstance())
        console.log('📁 Configured paths:', {
            audioOutputPath: this.audioOutputPath,
            outputPath: this.outputPath,
            recordingMode: GLOBAL.get().recording_mode,
        })

        console.log('🎬 Starting audio recording...')

        this.page = page

        try {
            // Start FFmpeg process with audio recording and streaming
            this.ffmpegProcess = this.createAudioRecordingProcess()

            this.isRecording = true
            // Set recording start time to match the exact moment audio begins (sync signal time)
            this.recordingStartTime = Date.now()
            this.gracePeriodActive = false
            this.setupProcessMonitoring()

            console.log('Audio recording started successfully')
            this.emit('started', {
                outputPath: this.outputPath,
                isAudioOnly: GLOBAL.get().recording_mode === 'audio_only',
            })
        } catch (error) {
            console.error('Failed to start audio recording:', error)
            this.isRecording = false
            this.emit('error', { type: 'startError', error })
            throw error
        }
        await sleep(3000)
        await generateSyncSignal(page)
    }

    private createAudioRecordingProcess(): ChildProcess {
        const args: string[] = []

        console.log(
            '🛠️ Building FFmpeg args for audio recording + streaming...',
        )

        // Audio input - auto-detect PulseAudio config
        args.push('-f', 'pulse', '-i', 'virtual_speaker.monitor')

        // === OUTPUT 1: WAV (audio for transcription) ===
        args.push(
            '-map',
            '0:a', // Map audio from first input
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

        // === OUTPUT 2: Streaming audio (for sound level analysis) ===
        if (Streaming.instance) {
            args.push(
                '-map',
                '0:a', // Map audio from first input
                '-vn',
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
            console.log(
                `🎵 Streaming audio: ${STREAMING_SAMPLE_RATE}Hz float32 enabled`,
            )
        }

        console.log('🎯 Audio recording: WAV + streaming')
        console.log('🛠️ FFmpeg command:', 'ffmpeg', args.join(' '))
        console.log('📁 Output WAV path:', this.audioOutputPath)

        const process = spawn('ffmpeg', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        // Log all stderr for debugging
        process.stderr?.on('data', (data) => {
            const output = data.toString()
            console.log('FFmpeg stderr:', output.trim())
        })

        return process
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

        // Handle streaming audio output (pipe:1)
        this.ffmpegProcess.stdout?.on('data', (data: Buffer) => {
            if (Streaming.instance) {
                const float32Array = new Float32Array(
                    data.buffer,
                    data.byteOffset,
                    data.length / 4,
                )
                Streaming.instance.processAudioChunk(float32Array)
            }
        })

        this.ffmpegProcess.stderr?.on('data', (data) => {
            const output = data.toString()
            if (output.includes('error')) {
                console.error('FFmpeg stderr:', output.trim())
            }
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

        const gracePeriodMs = (GRACE_PERIOD_SECONDS || 3) * 1000

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
        filesUploaded: boolean
        gracePeriodActive: boolean
        recordingDurationMs: number
    } {
        return {
            isRecording: this.isRecording,
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

    private async handleSuccessfulRecording(): Promise<void> {
        console.log('Audio recording completed')

        // // Post-process audio file to remove corrupted endings
        // await this.postProcessRecordings()

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
                    console.warn(
                        '⚠️ No Playwright video found, keeping audio-only recording',
                    )
                }
            } catch (error) {
                console.error('❌ Video-audio merge failed:', error)
                console.warn('⚠️ Continuing with audio-only recording')
            }
        }

        // Split WAV into 1-hour chunks for transcription if needed
        if (
            GLOBAL.get().speech_to_text_provider &&
            GLOBAL.get().speech_to_text_provider !== 'Default'
        ) {
            try {
                await this.splitWAVForTranscription()
                console.log('✅ WAV splitting for transcription completed')
            } catch (error) {
                console.error('❌ WAV splitting failed:', error)
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
    }

    private async mergeVideoWithAudio(
        playwrightVideoPath: string,
    ): Promise<void> {
        console.log('🎬 Calculating synchronization offset...')

        try {
            // Calculate the offset between video and audio
            const syncResult = await calculateVideoOffset(
                this.audioOutputPath,
                playwrightVideoPath,
            )

            console.log(
                `🎯 Sync offset: ${syncResult.offsetSeconds.toFixed(3)}s (confidence: ${(syncResult.confidence * 100).toFixed(1)}%)`,
            )

            // Apply offset to align audio with video
            const audioOffset = syncResult.offsetSeconds

            console.log(
                '🔄 Trimming individual files with offset compensation...',
            )

            // First, trim the individual files accounting for the offset
            await this.trimIndividualFiles(audioOffset)

            console.log(
                '🔄 Merging pre-trimmed video and audio without offset...',
            )
            console.log(
                '📹 Converting VP8/WebM to H.264/MP4 for compatibility...',
            )

            return new Promise((resolve, reject) => {
                const ffmpegArgs = [
                    '-y', // Overwrite output file
                    '-i',
                    playwrightVideoPath, // Video input (WebM/VP8) - already trimmed
                    '-i',
                    this.audioOutputPath, // Audio input (WAV) - already trimmed
                    '-c:v',
                    'libx264', // Re-encode video to H.264 for MP4 compatibility
                    '-preset',
                    'fast', // Fast encoding preset
                    '-crf',
                    '23', // Good quality/size balance
                    '-c:a',
                    'aac', // Encode audio to AAC
                    '-shortest', // End when shortest stream ends
                    this.outputPath,
                ]

                console.log(
                    '🛠️ FFmpeg command:',
                    'ffmpeg',
                    ffmpegArgs.join(' '),
                )
                console.log('🎬 Merging pre-trimmed files without offset')

                const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                })

                ffmpegProcess.on('error', (error) => {
                    console.error('❌ FFmpeg merge error:', error)
                    reject(error)
                })

                ffmpegProcess.on('exit', async (code) => {
                    if (code === 0) {
                        console.log(
                            '✅ Video-audio merge completed successfully',
                        )

                        // Clean up individual files after successful merge
                        this.cleanupIndividualFiles(playwrightVideoPath)

                        resolve()
                    } else {
                        console.error(
                            `❌ FFmpeg merge failed with code ${code}`,
                        )
                        reject(
                            new Error(
                                `FFmpeg merge process failed with exit code ${code}`,
                            ),
                        )
                    }
                })

                ffmpegProcess.stderr?.on('data', (data) => {
                    const output = data.toString()
                    // Log all stderr for debugging codec issues
                    console.log('FFmpeg stderr:', output.trim())
                })
            })
        } catch (error) {
            console.error('❌ Video-audio merge failed:', error)
            throw error
        }
    }

    private async trimIndividualFiles(audioOffset: number): Promise<void> {
        try {
            // Get the meeting startTime from the recording state
            const meetingStartTime = this.meetingStartTime
            const recordingStartTime = this.recordingStartTime

            if (!meetingStartTime || !recordingStartTime) {
                console.warn(
                    '⚠️ No meeting start time available, skipping trim',
                )
                return
            }

            // Calculate the offset from recording start to meeting start
            const trimOffsetSeconds =
                (meetingStartTime - recordingStartTime) / 1000

            if (trimOffsetSeconds <= 0) {
                console.log('✅ No trim needed - meeting started immediately')
                return
            }

            console.log(
                `✂️ Trimming individual files (${trimOffsetSeconds.toFixed(3)}s offset)...`,
            )
            console.log(
                `📅 Recording started: ${new Date(recordingStartTime).toISOString()}`,
            )
            console.log(
                `📅 Meeting started: ${new Date(meetingStartTime).toISOString()}`,
            )
            console.log(
                `🎵 Audio offset: ${audioOffset.toFixed(3)}s (audio is ${audioOffset > 0 ? 'behind' : 'ahead of'} video)`,
            )

            // Trim both files in parallel
            await Promise.all([
                this.trimWAVFile(trimOffsetSeconds, audioOffset),
                this.trimVideoFile(trimOffsetSeconds, audioOffset),
            ])

            console.log('✅ Individual files trimmed successfully')
        } catch (error) {
            console.error('❌ Individual file trimming failed:', error)
            throw error
        }
    }

    private async trimWAVFile(
        trimOffsetSeconds: number,
        audioOffset: number,
    ): Promise<void> {
        // WAV is trimmed at meeting start time (no offset adjustment needed)
        // The sync signal (bip) handles the audio-video synchronization automatically
        console.log(
            `🎵 WAV trim: ${trimOffsetSeconds.toFixed(3)}s (sync signal handles alignment)`,
        )
        if (trimOffsetSeconds <= 0) {
            console.log('✅ WAV: No trim needed')
            return
        }

        const tempWavPath = this.audioOutputPath + '.temp.wav'
        const ffmpegArgs = [
            '-y', // Overwrite output file
            '-i',
            this.audioOutputPath, // Input audio
            '-ss',
            trimOffsetSeconds.toFixed(3), // Start from meeting start time
            '-c',
            'copy', // Copy streams without re-encoding (fast)
            tempWavPath,
        ]

        console.log('🛠️ WAV trim command:', 'ffmpeg', ffmpegArgs.join(' '))

        return new Promise((resolve, reject) => {
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', (error) => {
                console.error('❌ FFmpeg WAV trim error:', error)
                reject(error)
            })

            ffmpegProcess.on('exit', (code) => {
                if (code === 0) {
                    // Replace original file with trimmed version
                    fs.renameSync(tempWavPath, this.audioOutputPath)
                    console.log(
                        `✅ WAV trimmed successfully (removed ${trimOffsetSeconds.toFixed(3)}s of pre-meeting content)`,
                    )
                    resolve()
                } else {
                    console.error(`❌ FFmpeg WAV trim failed with code ${code}`)
                    // Clean up temp file if it exists
                    if (fs.existsSync(tempWavPath)) {
                        fs.unlinkSync(tempWavPath)
                    }
                    reject(
                        new Error(
                            `FFmpeg WAV trim process failed with exit code ${code}`,
                        ),
                    )
                }
            })

            ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                console.log('FFmpeg WAV trim stderr:', output.trim())
            })
        })
    }

    private async trimVideoFile(
        trimOffsetSeconds: number,
        audioOffset: number,
    ): Promise<void> {
        // Get the Playwright video path
        const playwrightVideoPath = await this.retrievePlaywrightVideo()
        if (!playwrightVideoPath) {
            throw new Error('No Playwright video found for trimming')
        }

        // Adjust video trim to account for audio-video offset
        // If audio is behind video (positive offset), we need to trim video later
        // Add compensation for audio being very far ahead (large sync offset detected)

        const adjustedTrimOffset =
            trimOffsetSeconds + audioOffset + AUDIO_OFFSET_COMPENSATION

        console.log(
            `🎬 Video trim adjustment: ${trimOffsetSeconds.toFixed(3)}s + ${audioOffset.toFixed(3)}s + ${AUDIO_OFFSET_COMPENSATION.toFixed(3)}s compensation = ${adjustedTrimOffset.toFixed(3)}s`,
        )

        if (adjustedTrimOffset <= 0) {
            console.log('✅ Video: No trim needed after offset adjustment')
            return
        }

        const tempVideoPath = playwrightVideoPath + '.temp.webm'
        const ffmpegArgs = [
            '-y', // Overwrite output file
            '-i',
            playwrightVideoPath, // Input video (Playwright video)
            '-ss',
            adjustedTrimOffset.toFixed(3), // Start from adjusted meeting start time
            '-c',
            'copy', // Copy streams without re-encoding (fast)
            tempVideoPath,
        ]

        console.log('🛠️ Video trim command:', 'ffmpeg', ffmpegArgs.join(' '))

        return new Promise((resolve, reject) => {
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', (error) => {
                console.error('❌ FFmpeg video trim error:', error)
                reject(error)
            })

            ffmpegProcess.on('exit', (code) => {
                if (code === 0) {
                    // Replace original file with trimmed version
                    fs.renameSync(tempVideoPath, playwrightVideoPath)
                    console.log(
                        `✅ Video trimmed successfully (removed ${adjustedTrimOffset.toFixed(3)}s of pre-meeting content)`,
                    )
                    resolve()
                } else {
                    console.error(
                        `❌ FFmpeg video trim failed with code ${code}`,
                    )
                    // Clean up temp file if it exists
                    if (fs.existsSync(tempVideoPath)) {
                        fs.unlinkSync(tempVideoPath)
                    }
                    reject(
                        new Error(
                            `FFmpeg video trim process failed with exit code ${code}`,
                        ),
                    )
                }
            })

            ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                console.log('FFmpeg video trim stderr:', output.trim())
            })
        })
    }

    /**
     * Set the meeting start time (when the bot actually joined the meeting)
     * This is used to trim the video to remove pre-meeting content
     */
    public setMeetingStartTime(startTime: number): void {
        this.meetingStartTime = startTime
        console.log(
            `📅 Meeting start time set: ${new Date(startTime).toISOString()}`,
        )
    }

    /**
     * Set the recording start time (when video recording actually begins)
     * This should be called immediately after opening the Playwright page
     */
    public setRecordingStartTime(startTime: number): void {
        this.recordingStartTime = startTime
        console.log(
            `📅 Recording start time set: ${new Date(startTime).toISOString()}`,
        )
    }

    private async splitWAVForTranscription(): Promise<void> {
        if (!fs.existsSync(this.audioOutputPath)) {
            console.warn('⚠️ WAV file not found for transcription splitting')
            return
        }

        console.log('🎵 Splitting WAV into 1-hour chunks for transcription...')

        try {
            // Get WAV duration using FFmpeg
            const duration = await this.getWAVDuration()
            const chunkDuration = 3600 // 1 hour in seconds
            const chunks = Math.ceil(duration / chunkDuration)

            console.log(
                `📊 WAV duration: ${duration.toFixed(1)}s, creating ${chunks} chunks`,
            )

            const identifier = PathManager.getInstance().getIdentifier()
            const chunkPromises: Promise<void>[] = []

            for (let i = 0; i < chunks; i++) {
                const startTime = i * chunkDuration
                const endTime = Math.min((i + 1) * chunkDuration, duration)
                const chunkDurationActual = endTime - startTime

                if (chunkDurationActual <= 0) continue

                const chunkPromise = this.createWAVChunk(
                    startTime,
                    chunkDurationActual,
                    i,
                    identifier,
                )
                chunkPromises.push(chunkPromise)
            }

            await Promise.all(chunkPromises)
            console.log(`✅ Created ${chunks} WAV chunks for transcription`)
        } catch (error) {
            console.error('❌ WAV splitting failed:', error)
            throw error
        }
    }

    private async getWAVDuration(): Promise<number> {
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-i',
                this.audioOutputPath,
                '-show_entries',
                'format=duration',
                '-v',
                'quiet',
                '-of',
                'csv=p=0',
            ]

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            let output = ''
            ffmpegProcess.stdout?.on('data', (data) => {
                output += data.toString()
            })

            ffmpegProcess.on('error', (error) => {
                reject(error)
            })

            ffmpegProcess.on('exit', (code) => {
                if (code === 0) {
                    const duration = parseFloat(output.trim())
                    resolve(duration)
                } else {
                    reject(
                        new Error(
                            `FFmpeg duration check failed with code ${code}`,
                        ),
                    )
                }
            })
        })
    }

    private async createWAVChunk(
        startTime: number,
        duration: number,
        chunkIndex: number,
        identifier: string,
    ): Promise<void> {
        const chunkPath = `${this.audioOutputPath}.chunk${chunkIndex}.wav`

        const ffmpegArgs = [
            '-y', // Overwrite output file
            '-i',
            this.audioOutputPath, // Input WAV
            '-ss',
            startTime.toFixed(3), // Start time
            '-t',
            duration.toFixed(3), // Duration
            '-c',
            'copy', // Copy streams without re-encoding
            chunkPath,
        ]

        console.log(
            `🛠️ Creating chunk ${chunkIndex + 1}: ${startTime.toFixed(1)}s - ${(startTime + duration).toFixed(1)}s`,
        )

        return new Promise((resolve, reject) => {
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', (error) => {
                console.error(`❌ FFmpeg chunk ${chunkIndex} error:`, error)
                reject(error)
            })

            ffmpegProcess.on('exit', async (code) => {
                if (code === 0) {
                    try {
                        // Upload chunk to S3
                        if (this.s3Uploader) {
                            const botUuid = GLOBAL.get().bot_uuid
                            const s3Key = `${botUuid}/${botUuid}-${chunkIndex}.wav`
                            await this.s3Uploader.uploadFile(
                                chunkPath,
                                GLOBAL.get().aws_s3_temporary_audio_bucket,
                                s3Key,
                                [],
                                true,
                            )
                            console.log(
                                `📤 Uploaded chunk ${chunkIndex + 1} to S3: ${s3Key}`,
                            )
                        }

                        // Clean up local chunk file
                        fs.unlinkSync(chunkPath)
                        resolve()
                    } catch (error) {
                        console.error(
                            `❌ Failed to upload chunk ${chunkIndex}:`,
                            error,
                        )
                        // Clean up local file even if upload fails
                        if (fs.existsSync(chunkPath)) {
                            fs.unlinkSync(chunkPath)
                        }
                        reject(error)
                    }
                } else {
                    console.error(
                        `❌ FFmpeg chunk ${chunkIndex} failed with code ${code}`,
                    )
                    reject(
                        new Error(
                            `FFmpeg chunk process failed with exit code ${code}`,
                        ),
                    )
                }
            })

            ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                if (output.includes('error')) {
                    console.log(
                        `FFmpeg chunk ${chunkIndex} stderr:`,
                        output.trim(),
                    )
                }
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
