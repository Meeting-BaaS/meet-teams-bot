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
    private tempAudioOutputPath: string = '' // Path for temporary audio file (with bip)
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
            this.tempAudioOutputPath = PathManager.getInstance().getTempPath() + '/' + pathManager.getIdentifier() + '.wav'
        } else {
            this.outputPath = pathManager.getOutputPath() + '.mp4'
            this.audioOutputPath = pathManager.getOutputPath() + '.wav'
            this.tempAudioOutputPath = PathManager.getInstance().getTempPath() + '/' + pathManager.getIdentifier() + '.wav'
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
            // Keep files for analysis - don't delete immediately
            console.log('📁 Keeping files for analysis:')
            console.log(`   - Playwright video: ${playwrightVideoPath}`)
            console.log(`   - Audio WAV (final): ${this.audioOutputPath}`)
            console.log(`   - Audio WAV (original with bip): ${this.tempAudioOutputPath}`)
            console.log('🗑️ Files will be cleaned up later by upload process')
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
            this.tempAudioOutputPath,
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
        console.log('📁 Output WAV path:', this.tempAudioOutputPath)

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

        // Upload audio file (always available) - only upload the final version
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

        // Keep the temporary audio file (with bip) for analysis
        if (fs.existsSync(this.tempAudioOutputPath)) {
            console.log(`📁 Preserving original WAV with bip for analysis: ${this.tempAudioOutputPath}`)
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
        console.log('🎬 CORRECT APPROACH: Calculate offset, merge, then trim correctly...')

        try {
            // Step 1: Calculate sync offset on original files (with bip/flash)
            console.log('🔍 Step 1: Calculating synchronization offset...')
            const syncResult = await calculateVideoOffset(
                this.tempAudioOutputPath, // Use temp file with bip
                playwrightVideoPath,
            )

            console.log(
                `🎯 Sync offset: ${syncResult.offsetSeconds.toFixed(3)}s (confidence: ${(syncResult.confidence * 100).toFixed(1)}%)`,
            )

            // Step 2: Merge with offset
            const audioOffset = syncResult.offsetSeconds
            console.log('🔄 Step 2: Merging audio + video with calculated offset...')
            
            const mergedVideoPath = this.outputPath + '.merged.mp4'
            await this.mergeWithOffset(audioOffset, mergedVideoPath, playwrightVideoPath, this.tempAudioOutputPath)

            // Step 3: Trim merged video (CORRECTLY accounting for audio delay)
            const trimmedVideoPath = this.outputPath + '.trimmed.mp4'
            await this.trimMergedVideo(mergedVideoPath, trimmedVideoPath, audioOffset)

            // Step 4: Extract audio from trimmed video
            await this.extractAudioFromVideo(trimmedVideoPath)

            // Step 5: Move trimmed video to final location
            fs.renameSync(trimmedVideoPath, this.outputPath)

            // Clean up intermediate files
            if (fs.existsSync(mergedVideoPath)) {
                fs.unlinkSync(mergedVideoPath)
            }

            console.log('✅ Video-audio merge completed with correct approach')
            console.log(`📁 Original WAV preserved: ${this.tempAudioOutputPath}`)
            console.log(`📁 Final WAV: ${this.audioOutputPath}`)
            console.log(`📁 Final MP4: ${this.outputPath}`)

            // Clean up individual files after successful merge
            this.cleanupIndividualFiles(playwrightVideoPath)

        } catch (error) {
            console.error('❌ Video-audio merge failed:', error)
            throw error
        }
    }

    private async mergeWithOffset(audioOffset: number, outputPath: string, videoPath: string, audioPath: string): Promise<void> {
        console.log(`🔄 Step 1: Merging audio + video with AUDIO delay...`)
        
        // COMPENSATION: Ajouter 724ms pour corriger le décalage résiduel du trim FFmpeg
        const compensatedOffset = audioOffset + 0.724 // 724ms de compensation exacte
        console.log(`🎯 Audio delay: ${audioOffset.toFixed(3)}s (original) + 0.724s (trim compensation) = ${compensatedOffset.toFixed(3)}s`)
        
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-y', // Overwrite output file
                '-i', audioPath, // Audio input (with bip)
                '-i', videoPath, // Video input (with flash)
                // Delay audio with compensation
                '-filter_complex', `[0:a]adelay=${Math.round(compensatedOffset * 1000)}|${Math.round(compensatedOffset * 1000)}[a]`,
                '-map', '[a]', // Use the delayed audio
                '-map', '1:v', // Use the original video
                '-c:v', 'libx264', // Re-encode video to H.264 for MP4 compatibility
                '-preset', 'fast', // Fast encoding preset
                '-crf', '23', // Good quality/size balance
                '-c:a', 'aac', // Encode audio to AAC
                '-shortest', // End when shortest stream ends
                outputPath,
            ]

            console.log(
                '🛠️ FFmpeg merge command (AUDIO DELAY + COMPENSATION):',
                'ffmpeg',
                ffmpegArgs.join(' '),
            )

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', (error) => {
                console.error('❌ FFmpeg merge error:', error)
                reject(error)
            })

            ffmpegProcess.on('exit', (code) => {
                if (code === 0) {
                    console.log('✅ Merge completed with AUDIO delay + compensation alignment')
                    resolve()
                } else {
                    console.error(`❌ FFmpeg merge failed with code ${code}`)
                    reject(
                        new Error(
                            `FFmpeg merge process failed with exit code ${code}`,
                        ),
                    )
                }
            })

            ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                console.log('FFmpeg merge stderr:', output.trim())
            })
        })
    }

    private async extractAudioFromVideo(videoPath: string): Promise<void> {
        console.log('🔄 Step 3: Extracting audio from merged video to output.wav...')
        
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-y', // Overwrite output file
                '-i',
                videoPath, // Input merged video
                '-vn', // No video
                '-acodec',
                'pcm_s16le', // WAV format
                '-ac',
                '1', // Mono
                '-ar',
                '16000', // 16kHz sample rate
                this.audioOutputPath, // Output WAV
            ]

            console.log('🛠️ FFmpeg extract command:', 'ffmpeg', ffmpegArgs.join(' '))

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', (error) => {
                console.error('❌ FFmpeg extract error:', error)
                reject(error)
            })

            ffmpegProcess.on('exit', (code) => {
                if (code === 0) {
                    console.log('✅ Audio extracted successfully')
                    resolve()
                } else {
                    console.error(`❌ FFmpeg extract failed with code ${code}`)
                    reject(
                        new Error(
                            `FFmpeg extract process failed with exit code ${code}`,
                        ),
                    )
                }
            })

            ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                console.log('FFmpeg extract stderr:', output.trim())
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
        console.log(`📁 WAV file path: ${this.audioOutputPath}`)

        try {
            // Get WAV duration using FFprobe
            console.log('🔍 Step 1: Getting WAV duration...')
            const duration = await this.getWAVDuration()
            const chunkDuration = 3600 // 1 hour in seconds
            const chunks = Math.ceil(duration / chunkDuration)

            console.log(
                `📊 WAV duration: ${duration.toFixed(1)}s, creating ${chunks} chunks`,
            )

            const identifier = PathManager.getInstance().getIdentifier()
            console.log(`🔍 Step 2: Creating ${chunks} chunks with identifier: ${identifier}`)
            
            const chunkPromises: Promise<void>[] = []

            for (let i = 0; i < chunks; i++) {
                const startTime = i * chunkDuration
                const endTime = Math.min((i + 1) * chunkDuration, duration)
                const chunkDurationActual = endTime - startTime

                if (chunkDurationActual <= 0) {
                    console.log(`⚠️ Skipping chunk ${i} (duration: ${chunkDurationActual}s)`)
                    continue
                }

                console.log(`🔍 Step 3: Creating chunk ${i} (${startTime.toFixed(1)}s - ${endTime.toFixed(1)}s)`)
                const chunkPromise = this.createWAVChunk(
                    startTime,
                    chunkDurationActual,
                    i,
                    identifier,
                )
                chunkPromises.push(chunkPromise)
            }

            console.log(`🔍 Step 4: Waiting for ${chunkPromises.length} chunks to complete...`)
            await Promise.all(chunkPromises)
            console.log(`✅ Created ${chunks} WAV chunks for transcription`)
        } catch (error) {
            console.error('❌ WAV splitting failed:', error)
            console.error('❌ Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)))
            throw error
        }
    }

    private async getWAVDuration(wavPath?: string): Promise<number> {
        const audioPath = wavPath || this.audioOutputPath
        
        return new Promise((resolve, reject) => {
            const ffprobeArgs = [
                '-i',
                audioPath,
                '-show_entries',
                'format=duration',
                '-v',
                'quiet',
                '-of',
                'csv=p=0',
            ]

            console.log(`🔍 Getting WAV duration for: ${audioPath}`)
            console.log('🛠️ FFprobe duration command:', 'ffprobe', ffprobeArgs.join(' '))

            const ffprobeProcess = spawn('ffprobe', ffprobeArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            let output = ''
            let errorOutput = ''
            
            ffprobeProcess.stdout?.on('data', (data) => {
                output += data.toString()
            })

            ffprobeProcess.stderr?.on('data', (data) => {
                errorOutput += data.toString()
            })

            ffprobeProcess.on('error', (error) => {
                console.error('❌ FFprobe duration process error:', error)
                reject(error)
            })

            ffprobeProcess.on('exit', (code) => {
                if (code === 0) {
                    const duration = parseFloat(output.trim())
                    console.log(`✅ WAV duration: ${duration}s`)
                    resolve(duration)
                } else {
                    console.error(`❌ FFprobe duration failed with code ${code}`)
                    console.error('❌ FFprobe stderr:', errorOutput)
                    reject(
                        new Error(
                            `FFprobe duration check failed with exit code ${code}`,
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

    private async trimMergedVideo(
        mergedVideoPath: string,
        trimmedVideoPath: string,
        audioOffset: number,
    ): Promise<void> {
        console.log('✂️ Trimming merged video to remove pre-meeting content...')
        
        // Calculate trim offset from meeting start time
        const meetingStartTime = this.meetingStartTime
        const recordingStartTime = this.recordingStartTime

        if (!meetingStartTime || !recordingStartTime) {
            console.warn('⚠️ No meeting start time available, copying files without trim')
            fs.copyFileSync(mergedVideoPath, trimmedVideoPath)
            return
        }

        const baseTrimOffsetSeconds = (meetingStartTime - recordingStartTime) / 1000

        if (baseTrimOffsetSeconds <= 0) {
            console.log('✅ No trim needed - meeting started immediately')
            fs.copyFileSync(mergedVideoPath, trimmedVideoPath)
            return
        }

        // CORRECTION: Le trim doit tenir compte du delay audio appliqué
        // Si on a délayé l'audio de X secondes, le point de sync s'est décalé
        const adjustedTrimOffset = baseTrimOffsetSeconds + audioOffset
        
        console.log(`📊 Base trim: ${baseTrimOffsetSeconds.toFixed(3)}s`)
        console.log(`📊 Audio delay applied: ${audioOffset.toFixed(3)}s`) 
        console.log(`📊 Adjusted trim: ${adjustedTrimOffset.toFixed(3)}s`)

        await this.trimVideoFile(adjustedTrimOffset, mergedVideoPath, trimmedVideoPath)
    }

    private async trimVideoFile(trimOffset: number, inputPath: string, outputPath: string): Promise<void> {
        console.log(`✂️ Trimming video file...`)
        
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-y',
                '-i', inputPath,
                '-ss', trimOffset.toFixed(3),
                '-c', 'copy',
                outputPath,
            ]

            console.log('🛠️ FFmpeg trim video:', 'ffmpeg', ffmpegArgs.join(' '))

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', reject)
            ffmpegProcess.on('exit', (code) => {
                if (code === 0) {
                    console.log('✅ Video trimmed successfully')
                    resolve()
                } else {
                    reject(new Error(`Video trim failed with code ${code}`))
                }
            })

            ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                if (output.includes('error')) {
                    console.log('FFmpeg video trim stderr:', output.trim())
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
