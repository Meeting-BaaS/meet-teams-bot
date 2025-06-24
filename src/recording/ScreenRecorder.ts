import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import { PassThrough } from 'stream'
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
    private videoConversionProcess: ChildProcess | null = null
    private videoStream: PassThrough | null = null

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
            // Get the original Playwright WebM (complete and reliable)
            const originalVideoPath = await this.getPlaywrightVideoPath()
            if (originalVideoPath && fs.existsSync(originalVideoPath)) {
                const stats = fs.statSync(originalVideoPath)
                console.log(`📹 Using original Playwright WebM: ${originalVideoPath} (${stats.size} bytes)`)
                
                if (stats.size > 1000) {
                    return originalVideoPath
                } else {
                    console.warn(`⚠️ WebM file too small (${stats.size} bytes)`)
                }
            }

            console.warn('❌ No video file available')
            return null

        } catch (error) {
            console.error('Error retrieving video:', error)
            return null
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

            // Start real-time video conversion if not audio-only
            // DISABLED: Real-time streaming causes incomplete video (missing final seconds)
            // Always use original WebM for sync - it's complete and reliable
            // if (GLOBAL.get().recording_mode !== 'audio_only') {
            //     await this.startRealtimeVideoConversion()
            // }

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

        // Stop real-time video conversion if running
        if (this.videoConversionProcess) {
            console.log('🛑 Stopping real-time video conversion process...')
            
            // End the video stream first to signal completion
            if (this.videoStream && !this.videoStream.destroyed) {
                this.videoStream.end()
            }
            
            // Give a short time for final processing, then terminate
            setTimeout(() => {
                if (this.videoConversionProcess && !this.videoConversionProcess.killed) {
                    this.videoConversionProcess.kill('SIGINT')
                }
            }, 2000) // 2 seconds for final processing
        }

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

    private async handleSuccessfulRecording(): Promise<void> {
        console.log('Audio recording completed')

        if (GLOBAL.get().recording_mode !== 'audio_only') {
            try {
                console.log('🎬 Waiting for WebM file to be complete...')
                
                // Wait longer for WebM to be fully written
                const playwrightVideoPath = await this.retrievePlaywrightVideo()
                if (playwrightVideoPath) {
                    console.log('🎬 WebM file found, waiting for completion...')
                    await this.waitForFileComplete(playwrightVideoPath, 15000) // 15 seconds max
                    
                    // Additional wait to ensure Playwright has finished writing
                    console.log('🎬 Additional wait for Playwright to finish...')
                    await sleep(2000)
                }
                
                console.log('🎬 Starting video-audio merge process...')

                // Retrieve Playwright video - simple approach
                const finalPlaywrightVideoPath = await this.retrievePlaywrightVideo()

                if (finalPlaywrightVideoPath) {
                    // Merge video with audio using synchronization
                    await this.mergeVideoWithAudio()
                    console.log('✅ Video-audio merge completed')
                } else {
                    console.warn(
                        '⚠️ No video file available for merge',
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

    private async getWebMDuration(webmPath: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const ffprobeArgs = [
                '-i', webmPath,
                '-show_entries', 'format=duration',
                '-v', 'quiet',
                '-of', 'csv=p=0',
            ]

            console.log(`🔍 Getting WebM duration for: ${webmPath}`)

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
                console.error('❌ FFprobe WebM duration process error:', error)
                reject(error)
            })

            ffprobeProcess.on('exit', (code) => {
                if (code === 0) {
                    const duration = parseFloat(output.trim())
                    console.log(`✅ WebM duration: ${duration}s`)
                    resolve(duration)
                } else {
                    console.error(`❌ FFprobe WebM duration failed with code ${code}`)
                    console.error('❌ FFprobe stderr:', errorOutput)
                    reject(new Error(`FFprobe WebM duration check failed with exit code ${code}`))
                }
            })
        })
    }

    private async mergeVideoWithAudio(): Promise<void> {
        console.log('🎬 SIMPLE MERGE: Trim files at sync points, then merge with offset 0')

        try {
            const playwrightVideoPath = await this.retrievePlaywrightVideo()
            
            if (!playwrightVideoPath) {
                throw new Error('No video file available for sync analysis')
            }

            // Verify WebM has valid duration before proceeding
            try {
                const webmDuration = await this.getWebMDuration(playwrightVideoPath)
                if (webmDuration < 1.0) {
                    throw new Error(`WebM duration too short: ${webmDuration}s`)
                }
                console.log(`✅ WebM duration valid: ${webmDuration.toFixed(1)}s`)
            } catch (error) {
                console.error('❌ WebM duration check failed:', error)
                throw new Error(`WebM file is invalid or incomplete: ${error}`)
            }

            // Step 1: Find sync signals
            console.log('🔍 Step 1: Finding sync signals...')
            const syncResult = await calculateVideoOffset(
                this.tempAudioOutputPath, // Original audio with bip
                playwrightVideoPath, // Original WebM with flash
            )

            // Calculate trim offsets (DON'T TOUCH - this is perfect!)
            const calcOffsetVideo = syncResult.videoTimestamp + ((this.meetingStartTime - this.recordingStartTime) / 1000 - syncResult.audioTimestamp)
            const calcOffsetAudio = (this.meetingStartTime - this.recordingStartTime) / 1000

            console.log(`🎯 Sync signals found:`)
            console.log(`   Audio bip at: ${syncResult.audioTimestamp.toFixed(3)}s`)
            console.log(`   Video flash at: ${syncResult.videoTimestamp.toFixed(3)}s`)
            console.log(`   Trim video at: ${calcOffsetVideo.toFixed(3)}s`)
            console.log(`   Trim audio at: ${calcOffsetAudio.toFixed(3)}s`)

            // Step 2: Convert WebM to MP4 and trim in one step
            const trimmedVideoPath = playwrightVideoPath + '.trimmed.mp4'
            console.log('🔄 Converting WebM to MP4 and trimming...')
            await this.convertAndTrimVideo(playwrightVideoPath, trimmedVideoPath, calcOffsetVideo)

            // Step 3: Trim audio
            console.log('✂️ Step 3: Trimming audio...')
            const trimmedAudioPath = this.tempAudioOutputPath + '.trimmed.wav'
            await this.trimAudioFile(this.tempAudioOutputPath, trimmedAudioPath, calcOffsetAudio)

            // Step 4: Merge trimmed files (no offset needed - they're already synced)
            console.log('🔄 Step 4: Merging trimmed files...')
            console.log('   → Files are already synchronized from trim, using offset 0')
            
            // Check durations before merging
            await this.checkTrimmedFilesDuration(trimmedAudioPath, trimmedVideoPath)
            
            await this.mergeFiles(this.outputPath, trimmedVideoPath, trimmedAudioPath)

            // Step 5: Extract final audio from merged video
            console.log('🎵 Step 5: Extracting final audio...')
            await this.extractAudioFromVideo(this.outputPath)

            // Clean up temporary files
            // const filesToClean = [trimmedAudioPath, trimmedVideoPath]
            
            // filesToClean.forEach(file => {
            //     if (fs.existsSync(file)) {
            //         fs.unlinkSync(file)
            //         console.log(`🗑️ Cleaned up: ${file}`)
            //     }
            // })

            console.log('✅ Video-audio merge completed successfully')

        } catch (error) {
            console.error('❌ Video-audio merge failed:', error)
            throw error
        }
    }

    private async convertAndTrimVideo(inputPath: string, outputPath: string, trimOffsetSeconds: number): Promise<void> {
        console.log(`🔄 Converting WebM to MP4 and trimming: ${trimOffsetSeconds.toFixed(3)}s → ${outputPath}`)
        
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-y',
                '-i', inputPath,
                '-ss', trimOffsetSeconds.toFixed(3),
                '-avoid_negative_ts', 'make_zero',
                '-fflags', '+genpts',
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '23',
                outputPath,
            ]

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', (error) => {
                console.error('❌ Video trim error:', error)
                reject(error)
            })

            ffmpegProcess.on('exit', async (code) => {
                if (code === 0) {
                    console.log('✅ Video trimmed successfully (re-encoded)')
                    
                    // Check start time after re-encode
                    await this.checkVideoStartTime(outputPath)
                    
                    resolve()
                } else {
                    console.error(`❌ Video trim failed with code ${code}`)
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

    private async waitForFileComplete(filePath: string, maxWaitMs: number = 30000): Promise<void> {
        console.log(`⏳ Waiting for file to be complete: ${filePath}`)
        
        const startTime = Date.now()
        let lastSize = 0
        let stableCount = 0
        
        while (Date.now() - startTime < maxWaitMs) {
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath)
                const currentSize = stats.size
                
                if (currentSize === lastSize) {
                    stableCount++
                    if (stableCount >= 3) { // File size stable for 3 checks
                        console.log(`✅ File size stable at ${currentSize} bytes`)
                        return
                    }
                } else {
                    stableCount = 0
                    lastSize = currentSize
                }
            }
            
            await sleep(1000) // Wait 1 second between checks
        }
        
        console.warn(`⚠️ Timeout waiting for file completion: ${filePath}`)
    }

    private async trimAudioFile(inputPath: string, outputPath: string, trimOffsetSeconds: number): Promise<void> {
        console.log(`✂️ Trimming audio: ${trimOffsetSeconds.toFixed(3)}s → ${outputPath}`)
        
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-y',
                '-i', inputPath,
                '-ss', trimOffsetSeconds.toFixed(3),
                '-avoid_negative_ts', 'make_zero',
                '-fflags', '+genpts',
                '-c:a', 'pcm_s16le',
                outputPath,
            ]

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', (error) => {
                console.error('❌ Audio trim error:', error)
                reject(error)
            })

            ffmpegProcess.on('exit', (code) => {
                if (code === 0) {
                    console.log('✅ Audio trimmed successfully (re-encoded with T0)')
                    resolve()
                } else {
                    console.error(`❌ Audio trim failed with code ${code}`)
                    reject(new Error(`Audio trim failed with code ${code}`))
                }
            })

            ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                if (output.includes('error')) {
                    console.log('FFmpeg audio trim stderr:', output.trim())
                }
            })
        })
    }

    private async mergeFiles(outputPath: string, videoPath: string, audioPath: string): Promise<void> {
        console.log(`🔄 Merging video + audio with offset 0 (already synced) → ${outputPath}`)
        
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-y', 
                '-i', audioPath, 
                '-i', videoPath,
                '-map', '0:a',  // Map audio from first input
                '-map', '1:v',  // Map video from second input
                '-c:v', 'libx264', 
                '-preset', 'fast', 
                '-crf', '23', 
                '-c:a', 'aac',
                '-shortest',  // Stop at the end of the shortest stream
                outputPath,
            ]

            console.log('🛠️ FFmpeg merge command:', 'ffmpeg', ffmpegArgs.join(' '))

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', (error) => {
                console.error('❌ Merge error:', error)
                reject(error)
            })

            ffmpegProcess.on('exit', async (code) => {
                if (code === 0) {
                    // Verify the output file contains video and check its duration
                    try {
                        const hasVideo = await this.verifyVideoContent(outputPath)
                        if (hasVideo) {
                            const finalDuration = await this.getVideoDuration(outputPath)
                            console.log(`✅ Merge completed successfully (offset 0) - Duration: ${finalDuration.toFixed(3)}s`)
                            resolve()
                        } else {
                            console.error('❌ Merged MP4 contains no video content')
                            reject(new Error('Merged MP4 contains no video content'))
                        }
                    } catch (error) {
                        console.error('❌ Failed to verify video content:', error)
                        reject(error)
                    }
                } else {
                    console.error(`❌ Merge failed with code ${code}`)
                    reject(new Error(`Merge process failed with exit code ${code}`))
                }
            })

            ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                if (output.includes('error') || output.includes('Duration')) {
                    console.log('FFmpeg merge stderr:', output.trim())
                }
            })
        })
    }

    private async verifyVideoContent(mp4Path: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const ffprobeArgs = [
                '-i', mp4Path,
                '-show_streams',
                '-select_streams', 'v',
                '-v', 'quiet',
            ]

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
                console.error('❌ FFprobe video verification error:', error)
                reject(error)
            })

            ffprobeProcess.on('exit', (code) => {
                if (code === 0) {
                    const hasVideo = output.includes('[STREAM]') && output.includes('codec_type=video')
                    console.log(`🔍 Video content verification: ${hasVideo ? '✅ Found video' : '❌ No video'}`)
                    resolve(hasVideo)
                } else {
                    console.error(`❌ FFprobe video verification failed with code ${code}`)
                    console.error('❌ FFprobe stderr:', errorOutput)
                    reject(new Error(`FFprobe video verification failed with exit code ${code}`))
                }
            })
        })
    }

    private async extractAudioFromVideo(videoPath: string): Promise<void> {
        console.log('🎵 Extracting audio from merged video...')
        
        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-y',
                '-i', videoPath,
                '-vn',
                '-acodec', 'pcm_s16le',
                '-ac', '1',
                '-ar', '16000',
                this.audioOutputPath,
            ]

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            })

            ffmpegProcess.on('error', (error) => {
                console.error('❌ Audio extraction error:', error)
                reject(error)
            })

            ffmpegProcess.on('exit', (code) => {
                if (code === 0) {
                    console.log('✅ Audio extracted successfully')
                    resolve()
                } else {
                    console.error(`❌ Audio extraction failed with code ${code}`)
                    reject(new Error(`Audio extraction failed with exit code ${code}`))
                }
            })

            ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                if (output.includes('error')) {
                    console.log('FFmpeg extract stderr:', output.trim())
                }
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

    private async getPlaywrightVideoPath(): Promise<string | null> {
        try {
            // Try to get the video path multiple times as it might not be available immediately
            for (let i = 0; i < 10; i++) {
                const videoPath = await this.page.video()?.path()
                if (videoPath && fs.existsSync(videoPath)) {
                    return videoPath
                }
                await sleep(1000) // Wait 1 second between attempts
            }
            return null
        } catch (error) {
            console.warn('Could not get Playwright video path:', error)
            return null
        }
    }

    private async checkTrimmedFilesDuration(audioPath: string, videoPath: string): Promise<void> {
        console.log('🔍 Checking trimmed files duration...')
        
        try {
            const audioDuration = await this.getWAVDuration(audioPath)
            const videoDuration = await this.getVideoDuration(videoPath)
            
            console.log(`📊 Files to merge:`)
            console.log(`   Audio: ${audioPath}`)
            console.log(`   Video: ${videoPath}`)
            console.log(`📊 Trimmed files duration:`)
            console.log(`   Audio: ${audioDuration.toFixed(3)}s`)
            console.log(`   Video: ${videoDuration.toFixed(3)}s`)
            
            if (Math.abs(audioDuration - videoDuration) > 0.5) {
                console.warn(`⚠️ Duration mismatch: ${Math.abs(audioDuration - videoDuration).toFixed(3)}s difference`)
                console.warn(`   → Final MP4 will be ${Math.min(audioDuration, videoDuration).toFixed(3)}s (shortest)`)
            } else {
                console.log('✅ Durations match well')
            }
        } catch (error) {
            console.warn('⚠️ Could not check durations:', error)
        }
    }

    private async getVideoDuration(videoPath: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const ffprobeArgs = [
                '-i', videoPath,
                '-show_entries', 'format=duration',
                '-v', 'quiet',
                '-of', 'csv=p=0',
            ]

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
                console.error('❌ FFprobe video duration process error:', error)
                reject(error)
            })

            ffprobeProcess.on('exit', (code) => {
                if (code === 0) {
                    const duration = parseFloat(output.trim())
                    resolve(duration)
                } else {
                    console.error(`❌ FFprobe video duration failed with code ${code}`)
                    reject(new Error(`FFprobe video duration check failed with exit code ${code}`))
                }
            })
        })
    }

    private async checkVideoStartTime(videoPath: string): Promise<number> {
        return new Promise((resolve, reject) => {
            const ffprobeArgs = [
                '-i', videoPath,
                '-show_entries', 'format=start_time',
                '-v', 'quiet',
                '-of', 'csv=p=0',
            ]

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
                console.error('❌ FFprobe start time process error:', error)
                reject(error)
            })

            ffprobeProcess.on('exit', (code) => {
                if (code === 0) {
                    const startTime = parseFloat(output.trim()) || 0
                    console.log(`🔍 Video start time: ${startTime.toFixed(3)}s`)
                    resolve(startTime)
                } else {
                    console.error(`❌ FFprobe start time failed with code ${code}`)
                    reject(new Error(`FFprobe start time check failed with exit code ${code}`))
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

