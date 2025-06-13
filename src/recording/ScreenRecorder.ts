import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { MEETING_CONSTANTS } from '../state-machine/constants'
import { RecordingMode } from '../types'
import { PathManager } from '../utils/PathManager'
import { S3Uploader } from '../utils/S3Uploader'
import { SyncCalibrator, SyncResult } from './SyncCalibrator'
import { SystemDiagnostic } from '../utils/SystemDiagnostic'

export interface ScreenRecordingConfig {
    display: string
    audioDevice?: string
    outputFormat: 'webm' | 'mp4'
    videoCodec: 'libx264' | 'libvpx-vp9' | 'libvpx'
    audioCodec: 'aac' | 'opus' | 'libmp3lame'
    width: number
    height: number
    framerate: number
    chunkDuration: number // en millisecondes
    audioBitrate: string
    videoBitrate: string
    recordingMode?: RecordingMode
    enableTranscriptionChunking?: boolean
    transcriptionChunkDuration?: number
    transcriptionAudioBucket?: string
    bucketName?: string
    s3Path?: string
}

export class ScreenRecorder extends EventEmitter {
    private ffmpegProcess: ChildProcess | null = null
    private isRecording: boolean = false
    private config: ScreenRecordingConfig
    private outputPath: string = ''
    private audioOutputPath: string = ''
    private chunkIndex: number = 0
    private lastChunkTime: number = 0
    private syncCalibrator: SyncCalibrator
    private page: any = null // Page Playwright for sync signal generation
    private calibratedOffset: number = 0 // Offset measured once
    private systemDiagnostic: SystemDiagnostic
    
    // Nouvelles propriétés pour la compatibilité avec Transcoder
    private pathManager: PathManager | null = null
    private s3Uploader: S3Uploader | null = null
    private isConfigured: boolean = false
    private filesUploaded: boolean = false
    private chunkWatcher: any = null // File watcher for real-time chunk monitoring

    constructor(config: Partial<ScreenRecordingConfig> = {}) {
        super()
        
        // Déterminer le bucket audio selon l'environnement (comme dans Transcoder)
        const env = process.env.ENVIRON || 'local'
        let transcriptionAudioBucket: string

        if (env === 'prod') {
            transcriptionAudioBucket = 'meeting-baas-audio'
        } else if (env === 'preprod') {
            transcriptionAudioBucket = 'preprod-meeting-baas-audio'
        } else {
            transcriptionAudioBucket =
                process.env.AWS_S3_TEMPORARY_AUDIO_BUCKET ||
                'local-meeting-baas-audio'
        }

        console.log(
            `ScreenRecorder: Using transcription audio bucket for environment ${env}: ${transcriptionAudioBucket}`,
        )
        
        this.config = {
            display: process.env.DISPLAY || ':99',
            audioDevice: 'pulse',
            outputFormat: 'mp4', // Changé en mp4 par défaut
            videoCodec: 'libx264', // Changé pour de meilleures performances
            audioCodec: 'aac', // Changé pour compatibility
            width: 1280,
            height: 720,
            framerate: 30,
            chunkDuration: 3000, // 3 seconds per chunk
            audioBitrate: '128k',
            videoBitrate: '1000k',
            // Nouvelles propriétés par défaut
            recordingMode: 'speaker_view',
            enableTranscriptionChunking: false,
            transcriptionChunkDuration: 3600, // 1 hour like Transcoder
            transcriptionAudioBucket: transcriptionAudioBucket,
            bucketName: process.env.AWS_S3_VIDEO_BUCKET || '',
            s3Path: '',
            ...config
        }
        
        this.syncCalibrator = new SyncCalibrator()
        this.systemDiagnostic = new SystemDiagnostic()
        
        // Initialiser les composants S3 si pas en mode serverless
        if (process.env.SERVERLESS !== 'true') {
            this.s3Uploader = S3Uploader.getInstance()
        }
        
        console.log('ScreenRecorder initialized with enhanced config:', {
            recordingMode: this.config.recordingMode,
            enableTranscriptionChunking: this.config.enableTranscriptionChunking,
            transcriptionAudioBucket: this.config.transcriptionAudioBucket
        })
    }

    /**
     * Configuration method like in Transcoder - must be called before starting
     */
    public configure(
        pathManager: PathManager,
        recordingMode?: RecordingMode,
        meetingParams?: any,
    ): void {
        if (!pathManager) {
            throw new Error('PathManager is required for configuration')
        }

        this.pathManager = pathManager

        // Update recording mode if provided
        if (recordingMode) {
            this.config.recordingMode = recordingMode
        }

        // Update transcription chunking settings if meeting params are provided
        if (meetingParams) {
            // Check both formats of speech-to-text configuration (like in Transcoder)
            const hasTranscription =
                (meetingParams.speech_to_text_provider &&
                    meetingParams.speech_to_text_provider !== 'None') ||
                (meetingParams.speech_to_text &&
                    meetingParams.speech_to_text.provider &&
                    meetingParams.speech_to_text.provider !== 'None')

            this.config.enableTranscriptionChunking = hasTranscription

            console.log('ScreenRecorder transcription chunking setting:', {
                speech_to_text_provider: meetingParams.speech_to_text_provider,
                speech_to_text: meetingParams.speech_to_text,
                hasTranscription: hasTranscription,
                enableTranscriptionChunking: this.config.enableTranscriptionChunking,
            })
        }

        // Set output file paths - CHANGEMENT CLÉ: utiliser getOutputPath() directement
        const isAudioOnly = recordingMode === 'audio_only'
        
        if (isAudioOnly) {
            // Mode audio seul : sortie en .wav
            this.outputPath = pathManager.getOutputPath() + '.wav'
            this.audioOutputPath = this.outputPath // Le même fichier pour audio seul
        } else {
            // Mode vidéo + audio : sortie en .mp4 + .wav séparé
            this.outputPath = pathManager.getOutputPath() + '.mp4'
            this.audioOutputPath = pathManager.getOutputPath() + '.wav'
        }

        // Configure S3 paths
        const { bucketName, s3Path } = pathManager.getS3Paths()
        this.config.bucketName = bucketName
        this.config.s3Path = s3Path

        this.isConfigured = true

        console.log('ScreenRecorder configured:', {
            outputPath: this.outputPath,
            audioOutputPath: this.audioOutputPath,
            s3Path: this.config.s3Path,
            recordingMode: this.config.recordingMode,
            enableTranscriptionChunking: this.config.enableTranscriptionChunking,
        })
    }

    private validateStartConditions(): void {
        if (!this.isConfigured || !this.pathManager) {
            throw new Error(
                'ScreenRecorder must be configured with PathManager before starting',
            )
        }

        if (this.isRecording) {
            throw new Error('ScreenRecorder is already running')
        }

        const isAudioOnly = this.config.recordingMode === 'audio_only'
        const expectedExtension = isAudioOnly ? '.wav' : '.mp4'
        
        if (!this.outputPath.endsWith(expectedExtension)) {
            throw new Error(`Output path must have ${expectedExtension} extension for ${isAudioOnly ? 'audio-only' : 'video'} mode`)
        }
    }

    public setPage(page: any): void {
        this.page = page
        console.log('Page set for sync signal generation')
    }

    /**
     * Calibration once at startup
     */
    public async calibrateSync(): Promise<void> {
        if (!this.page) {
            console.warn('⚠️ No page set for sync calibration, skipping...')
            return
        }

        console.log('🎯 === ONE-TIME SYNC CALIBRATION ===')
        try {
            this.calibratedOffset = await this.syncCalibrator.calibrateOnce(this.page)
            console.log(`✅ Calibration complete! Will use offset: ${this.calibratedOffset}s`)
        } catch (error) {
            console.error('❌ Calibration failed, using offset 0:', error)
            this.calibratedOffset = 0
        }
    }

    public async startRecording(onChunk?: (chunk: Buffer, isFinal: boolean) => Promise<void>): Promise<void> {
        // Valider les conditions de démarrage
        this.validateStartConditions()
        
        if (this.isRecording) {
            throw new Error('Recording is already in progress')
        }

        console.log('🎬 Starting screen recording with enhanced config:', this.config)

        try {
            // Create output directories using PathManager
            await this.pathManager!.ensureDirectories()

            console.log('📁 Using output path:', this.outputPath)

            // Auto-calibration system for precise audio/video synchronization
            console.log('=== SYNC CALIBRATION SYSTEM ===')
            console.log('Hybrid approach: Quick estimation + precise flash+bip calibration')
            
            // Step 1: Quick load-based estimation (500ms)
            const quickLoad = await this.getSystemLoad()
            const roughEstimate = this.estimateOffsetFromLoad(quickLoad)
            console.log(`Step 1 - Quick estimate: ${roughEstimate.toFixed(3)}s (system load: ${quickLoad.toFixed(2)})`)
            
            // Step 2: Precise flash+bip calibration (1.5s)
            console.log('Step 2 - Precise calibration with flash+bip detection')
            const preciseOffset = await this.syncCalibrator.quickCalibrateOnceOptimized(this.page)
            
            // Step 3: Choose best result with fine-tuning
            let finalOffset: number
            if (Math.abs(preciseOffset) > 0.001) {
                // Calibration successful: use precise result
                let correctedOffset = -preciseOffset  // Invert detected offset
                
                // Fine-tuning: Additional empirical adjustment for optimal sync
                const fineTuning = 0.020  // 20ms additional compensation
                correctedOffset += fineTuning
                
                finalOffset = correctedOffset
                console.log(`Using PRECISE calibration: ${(-preciseOffset).toFixed(3)}s + fine-tuning: ${fineTuning.toFixed(3)}s`)
                console.log(`Final precise offset: ${finalOffset.toFixed(3)}s (flash+bip detected + fine-tuned)`)
            } else {
                // Calibration failed: fallback to estimation
                finalOffset = roughEstimate
                console.log(`Calibration failed, using system load estimate: ${finalOffset.toFixed(3)}s`)
            }
            
            console.log(`Final sync offset: ${finalOffset.toFixed(3)}s (${finalOffset > 0 ? 'delay audio' : 'advance audio'})`)
            console.log('Sync calibration completed - best of both worlds: speed + precision')

            // Build FFmpeg arguments with calibrated offset
            const ffmpegArgs = await this.buildFFmpegArgs(finalOffset)

            this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe']
            })

            this.isRecording = true
            this.lastChunkTime = Date.now()

            // Setup FFmpeg listeners
            this.setupFFmpegListeners()

            // Test if the file is created
            let fileCreated = false
            const checkFile = setInterval(() => {
                if (fs.existsSync(this.outputPath)) {
                    if (!fileCreated) {
                        console.log('Screen recording file created:', this.outputPath)
                        fileCreated = true
                    }
                    const stats = fs.statSync(this.outputPath)
                    if (stats.size > 0) {
                        console.log(`File size: ${stats.size} bytes`)
                    }
                }
            }, 1000)

            // Handle errors
            this.ffmpegProcess.on('error', (error) => {
                console.error('FFmpeg process error:', error)
                this.emit('error', error)
            })

            this.ffmpegProcess.on('exit', (code, signal) => {
                console.log(`FFmpeg process exited with code ${code} and signal ${signal}`)
                clearInterval(checkFile)
                
                if (code === 0) {
                    console.log('FFmpeg completed successfully!')
                    if (fs.existsSync(this.outputPath)) {
                        const stats = fs.statSync(this.outputPath)
                        console.log(`Final video file: ${stats.size} bytes`)
                    }
                    
                    // Démarrer les tâches post-enregistrement en arrière-plan
                    this.handlePostRecordingTasks()
                }
                
                this.isRecording = false
                this.emit('stopped')
            })

            // Timeout to detect if FFmpeg produces nothing
            setTimeout(() => {
                clearInterval(checkFile)
                if (!fileCreated && this.isRecording) {
                    console.error('WARNING: No file created after 10 seconds!')
                }
            }, 10000)

            console.log('Screen recording started successfully')
            console.log(`Using pre-calibrated sync offset: ${this.calibratedOffset}s`)
            this.emit('started', {
                outputPath: this.outputPath,
                isAudioOnly: false,
            })

        } catch (error) {
            console.error('💥 Failed to start screen recording:', error)
            this.isRecording = false
            this.emit('error', { type: 'startError', error })
            throw error
        }
    }

    private setupFFmpegListeners(): void {
        if (!this.ffmpegProcess) return

        // Reduce stdout logging to essential only
        this.ffmpegProcess.stdout?.on('data', (data) => {
            const output = data.toString()
            if (output.includes('Duration:') || output.includes('Output #0:')) {
                console.log('FFmpeg stdout:', output.trim())
            }
        })

        this.ffmpegProcess.stderr?.on('data', (data) => {
            const output = data.toString()
            // Only log errors and critical warnings, skip progress info
            if (output.includes('error') || output.includes('Error') || output.includes('failed') || output.includes('Invalid')) {
                console.error('FFmpeg stderr:', output.trim())
            }
            // Skip verbose progress info that creates CPU load
        })
    }

    private async buildFFmpegArgs(fixedAudioOffset: number): Promise<string[]> {
        const args: string[] = []
        const isAudioOnly = this.config.recordingMode === 'audio_only'

        console.log(`🛠️ Building FFmpeg args for ${isAudioOnly ? 'audio-only' : 'video+audio'} recording...`)
        console.log(`🎯 Applying audio offset: ${fixedAudioOffset.toFixed(3)}s`)

        if (isAudioOnly) {
            // Mode audio seul : capture uniquement l'audio
            args.push(
                '-f', 'pulse',
                '-thread_queue_size', '512',
                '-probesize', '50M',
                '-analyzeduration', '10000000',
                '-fflags', '+genpts',
                '-use_wallclock_as_timestamps', '1',
                '-itsoffset', fixedAudioOffset.toString(),
                '-i', 'virtual_speaker.monitor',
                
                // Audio encoding pour .wav
                '-acodec', 'pcm_s16le',
                '-ac', '1',     // Mono pour transcription
                '-ar', '16000', // 16kHz pour transcription
                '-f', 'wav',
                '-y',
                this.outputPath
            )
            
            console.log(`✅ Audio-only FFmpeg args built for: ${this.outputPath}`)
        } else {
            // Mode vidéo + audio : capture écran + audio (comme avant)
            
            // Input video 
            args.push(
                '-f', 'x11grab',
                '-video_size', '1280x880',
                '-framerate', '30',
                '-probesize', '50M',
                '-analyzeduration', '10000000',
                '-thread_queue_size', '512',       
                '-rtbufsize', '100M',              
                '-fflags', '+genpts',              
                '-use_wallclock_as_timestamps', '1',
                '-i', this.config.display
            )

            // Separate audio with synchronization + calibrated offset
            if (this.config.audioDevice) {
                args.push(
                    '-f', 'pulse',
                    '-thread_queue_size', '512',
                    '-probesize', '50M',
                    '-analyzeduration', '10000000',
                    '-fflags', '+genpts',              
                    '-use_wallclock_as_timestamps', '1', 
                    '-itsoffset', fixedAudioOffset.toString(),
                    '-i', 'virtual_speaker.monitor'
                )
                
                console.log(`✅ FFmpeg itsoffset parameter: ${fixedAudioOffset.toFixed(3)}s`)
            }

            // TRIPLE OUTPUT: MP4 + WAV + Chunks temps réel ! 🚀
            args.push(
                // === OUTPUT 1: MP4 (vidéo + audio) ===
                '-map', '0:v:0',                   // Map video
                '-map', '1:a:0',                   // Map audio
                
                // Video encoding optimized for real-time processing
                '-c:v', 'libx264',
                '-preset', 'medium',
                '-crf', '20',
                '-profile:v', 'high',
                '-level', '4.0',
                '-pix_fmt', 'yuv420p',
                
                // Crop for browser header
                '-vf', 'crop=1280:720:0:160',      
                
                // Audio encoding for MP4
                '-c:a', 'aac',
                '-b:a', '160k',
                '-ac', '2',
                '-ar', '48000',
                
                // Synchronization settings (REMOVED -shortest to fix audio cutoff!)
                // '-shortest',                    // REMOVED: Was cutting audio early when offset negative
                '-avoid_negative_ts', 'make_zero', 
                '-max_muxing_queue_size', '1024',  
                '-async', '1',                      // ADDED: Force audio sync for multiple outputs
                
                // Timing precision
                '-vsync', 'cfr',                   
                '-copyts',                         
                '-start_at_zero',                  
                
                // Output 1: MP4 file
                '-f', 'mp4',
                '-movflags', '+faststart',         
                this.outputPath,
                
                // === OUTPUT 2: WAV (audio seul avec delta déjà appliqué) ===
                '-map', '1:a:0',                   // Map same audio input
                '-vn',                             // No video for WAV
                '-acodec', 'pcm_s16le',           // WAV codec
                '-ac', '1',                        // Mono for transcription
                '-ar', '16000',                    // 16kHz for transcription
                '-async', '1',                     // ADDED: Force sync for WAV output
                '-avoid_negative_ts', 'make_zero', // ADDED: Handle timing for WAV
                '-f', 'wav',                       // WAV format
                this.audioOutputPath               // Output 2: WAV file
            )

            // === OUTPUT 3: Chunks audio temps réel (si chunking activé) ===
            const shouldCreateChunks = process.env.SERVERLESS !== 'true' && this.config.enableTranscriptionChunking
            if (shouldCreateChunks) {
                const chunkDurationSecs = this.config.transcriptionChunkDuration || 3600
                const chunksDir = `${this.pathManager!.getTempPath()}/realtime_chunks`
                
                // Créer le répertoire des chunks
                const fs = require('fs')
                if (!fs.existsSync(chunksDir)) {
                    fs.mkdirSync(chunksDir, { recursive: true })
                }
                
                const chunkPattern = `${chunksDir}/${this.pathManager!.getBotUuid()}-%03d.wav`
                
                args.push(
                    // === REAL-TIME CHUNKS (1h chacun) ===
                    '-map', '1:a:0',                     // Map same audio input
                    '-vn',                               // No video for chunks
                    '-acodec', 'pcm_s16le',             // WAV codec  
                    '-ac', '1',                          // Mono for transcription
                    '-ar', '16000',                      // 16kHz for transcription
                    '-f', 'segment',                     // Segment format
                    '-segment_time', chunkDurationSecs.toString(), // 1h par chunk
                    '-segment_format', 'wav',            // WAV segments
                    '-reset_timestamps', '1',            // Reset timestamps per segment
                    chunkPattern                         // Output pattern: botid-000.wav, botid-001.wav, etc.
                )
                
                // Démarrer le monitoring des chunks en temps réel
                this.startRealtimeChunkMonitoring(chunksDir)
                
                console.log(`🎯 REAL-TIME CHUNKS: Creating ${chunkDurationSecs}s chunks in ${chunksDir}`)
                console.log(`⚡ Chunks will be auto-uploaded as they are created!`)
            }
            
            console.log(`✅ Video+audio FFmpeg args built for: ${this.outputPath}`)
            console.log(`🎯 REAL-TIME AUDIO: WAV file will be created simultaneously at: ${this.audioOutputPath}`)
            console.log(`⚡ Delta ${fixedAudioOffset.toFixed(3)}s already applied to WAV - no post-processing needed!`)
            console.log(`🔧 FIXED: Removed -shortest to prevent audio cutoff when offset is negative`)
            console.log(`🔧 FIXED: Added -async 1 to force duration synchronization between MP4 and WAV outputs`)
        }

        return args
    }

    public async stopRecording(): Promise<void> {
        if (!this.isRecording || !this.ffmpegProcess) {
            console.warn('No recording in progress to stop')
            return
        }

        console.log('🛑 Stopping screen recording gracefully...')

        return new Promise((resolve) => {
            if (!this.ffmpegProcess) {
                resolve()
                return
            }

            // Listen for exit once
            this.ffmpegProcess.once('exit', async (code, signal) => {
                console.log(`FFmpeg stopped gracefully with code ${code}, signal ${signal}`)
                
                this.isRecording = false
                this.ffmpegProcess = null
                
                // Démarrer les tâches post-enregistrement si FFmpeg s'est arrêté correctement
                if (code === 0) {
                    await this.handlePostRecordingTasks()
                }
                
                resolve()
            })

            // Send SIGINT (Ctrl+C) for graceful shutdown instead of SIGTERM
            console.log('Sending SIGINT to FFmpeg for graceful shutdown...')
            this.ffmpegProcess.kill('SIGINT')

            // Safety timeout if FFmpeg doesn't respond
            setTimeout(() => {
                if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
                    console.warn('FFmpeg did not respond to SIGINT, forcing SIGKILL...')
                    this.ffmpegProcess.kill('SIGKILL')
                }
            }, 5000) // 5 seconds max for graceful shutdown
        })
    }

    /**
     * Handle post-recording tasks asynchronously (like in Transcoder)
     */
    private async handlePostRecordingTasks(): Promise<void> {
        console.log('🚀 Starting post-recording tasks...')

        try {
            // Emit stopped event early
            this.emit('stopped')

            // Add a small delay to prevent CPU spike
            await new Promise(resolve => setTimeout(resolve, 100))

            // ALWAYS create the complete audio WAV file FIRST (synchronously)
            await this.createCompleteAudioFile()

            // Upload the full recording (if not serverless)
            if (process.env.SERVERLESS !== 'true') {
                // Add another small delay before S3 upload
                await new Promise(resolve => setTimeout(resolve, 200))
                await this.uploadToS3()
            }

            // Handle transcription chunking in the background (non-blocking)
            this.handleTranscriptionChunkingAsync()

            console.log('✅ Post-recording tasks completed')
        } catch (error) {
            console.error('❌ Error in post-recording tasks:', error)
            throw error
        }
    }

    /**
     * Verify complete audio WAV file exists (ALWAYS created during recording now!)
     */
    private async createCompleteAudioFile(): Promise<void> {
        if (!this.pathManager) return

        const isAudioOnly = this.config.recordingMode === 'audio_only'
        
        // Vérifier que le fichier WAV existe (créé en temps réel maintenant)
        if (fs.existsSync(this.audioOutputPath)) {
            const stats = fs.statSync(this.audioOutputPath)
            console.log(`✅ WAV file already created during recording: ${this.audioOutputPath} (${stats.size} bytes)`)
        } else {
            console.error(`❌ WAV file missing: ${this.audioOutputPath}`)
            
            // Fallback: extraction comme avant (ne devrait plus être nécessaire)
            if (!isAudioOnly) {
                console.log('⚠️ Fallback: Extracting audio from MP4...')
                await this.createAudioFileForTranscription()
            }
        }
    }

    /**
     * Handle transcription chunking cleanup (chunks already created in real-time!)
     */
    private handleTranscriptionChunkingAsync(): void {
        if (!this.pathManager) return

        // Nettoyer le watcher et finir l'upload du dernier chunk  
        setTimeout(async () => {
            try {
                const shouldCreateChunks = process.env.SERVERLESS !== 'true' && this.config.enableTranscriptionChunking
                if (shouldCreateChunks) {
                    console.log('✅ Real-time chunks already created and uploaded during recording!')
                    console.log('🧹 Cleaning up chunk monitoring...')
                    
                    // Fermer le watcher
                    if (this.chunkWatcher) {
                        this.chunkWatcher.close()
                        this.chunkWatcher = null
                    }
                } else {
                    if (process.env.SERVERLESS === 'true') {
                        console.log('Serverless mode: no chunking was done')
                    } else {
                        console.log('Transcription chunking disabled: no chunking was done')
                    }
                }
            } catch (error) {
                console.error('Error in transcription chunking cleanup:', error)
                // Don't throw - these are background tasks
            }
        }, 1000) // Start after 1 second delay
    }

    /**
     * Create audio file for transcription from recorded video
     * NOTE: Cette méthode n'est appelée qu'en mode vidéo (pas audio-only)
     */
    private async createAudioFileForTranscription(): Promise<void> {
        if (!this.pathManager) return

        const isAudioOnly = this.config.recordingMode === 'audio_only'
        if (isAudioOnly) {
            console.log('Audio-only mode: WAV file already exists, no extraction needed')
            return
        }

        console.log('Creating audio WAV file from MP4 video...')
        console.log(`Input MP4 file: ${this.outputPath}`)
        console.log(`Output WAV file: ${this.audioOutputPath}`)

        // Verify the input MP4 file exists
        if (!fs.existsSync(this.outputPath)) {
            throw new Error(`Input MP4 file does not exist: ${this.outputPath}`)
        }

        const inputStats = fs.statSync(this.outputPath)
        console.log(`Input MP4 file size: ${inputStats.size} bytes`)

        return new Promise<void>((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', [
                '-i', this.outputPath,             // Input MP4 file
                '-vn',                             // No video
                '-acodec', 'pcm_s16le',           // WAV codec
                '-ac', '1',                        // Mono
                '-ar', '16000',                    // 16kHz for transcription
                '-y',                              // Overwrite
                this.audioOutputPath,              // Output WAV file
            ])

            ffmpeg.stderr?.on('data', (data) => {
                const output = data.toString()
                // Log important FFmpeg messages
                if (output.includes('error') || output.includes('Error') || output.includes('failed')) {
                    console.error('FFmpeg audio extraction stderr:', output)
                }
            })

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    // Verify the output file was created
                    if (fs.existsSync(this.audioOutputPath)) {
                        const outputStats = fs.statSync(this.audioOutputPath)
                        console.log(`Audio WAV file created successfully: ${this.audioOutputPath} (${outputStats.size} bytes)`)
                        resolve()
                    } else {
                        reject(new Error('Audio WAV file was not created despite FFmpeg success'))
                    }
                } else {
                    console.error(`Audio extraction failed with FFmpeg exit code: ${code}`)
                    reject(new Error(`Audio extraction failed with code ${code}`))
                }
            })

            ffmpeg.on('error', (error) => {
                console.error('FFmpeg audio extraction process error:', error)
                reject(error)
            })
        })
    }

    /**
     * Create and upload audio chunks for transcription (ported from Transcoder)
     * NOTE: Cette méthode n'est appelée que si les conditions sont réunies (serverless=false ET enableTranscriptionChunking=true)

    /**
     * Upload main recording to S3 (ported from Transcoder)
     */
    public async uploadToS3(): Promise<void> {
        console.log(
            `ScreenRecorder: Currently using transcription audio bucket: ${this.config.transcriptionAudioBucket}`,
        )
        if (!this.pathManager) {
            throw new Error('PathManager not available for S3 upload')
        }

        // Skip upload if files have already been uploaded
        if (this.filesUploaded) {
            console.log(
                'Files already uploaded to S3, skipping duplicate upload',
            )
            return
        }

        try {
            // Upload main output file
            if (!fs.existsSync(this.outputPath)) {
                throw new Error(
                    `Output file does not exist for upload: ${this.outputPath}`,
                )
            }

            const isAudioOnly = this.config.recordingMode === 'audio_only'
            const fileExtension = isAudioOnly ? '.wav' : '.mp4'
            const s3Key = `${this.pathManager.getIdentifier()}${fileExtension}`

            console.log('ScreenRecorder: Uploading file to S3:', {
                localPath: this.outputPath,
                bucketName: this.config.bucketName,
                s3Key: s3Key,
                mode: isAudioOnly ? 'audio-only' : 'video+audio',
            })

            if (this.s3Uploader) {
                await this.s3Uploader.uploadFile(
                    this.outputPath,
                    this.config.bucketName!,
                    s3Key,
                )

                console.log(
                    `File uploaded successfully, deleting local file: ${this.outputPath}`,
                )
                try {
                    fs.unlinkSync(this.outputPath)
                    console.log('Local file deleted successfully')
                } catch (deleteError) {
                    console.error(
                        'Failed to delete local file:',
                        deleteError,
                    )
                }

                // Mark files as uploaded to prevent duplicate uploads
                this.filesUploaded = true
                console.log(`ScreenRecorder: S3 upload completed (${fileExtension})`)
            }
        } catch (error) {
            console.error('ScreenRecorder: Error during S3 upload:', error)
            throw error
        }
    }
    // Existing methods (keeping the rest of the functionality)
    public isCurrentlyRecording(): boolean {
        return this.isRecording
    }

    public getConfig(): ScreenRecordingConfig {
        return { ...this.config }
    }

    public updateConfig(newConfig: Partial<ScreenRecordingConfig>): void {
        if (this.isRecording) {
            throw new Error('Cannot update config while recording')
        }
        this.config = { ...this.config, ...newConfig }
    }

    public getStatus(): {
        isRecording: boolean
        isConfigured: boolean
        chunksProcessed: number
        filesUploaded: boolean
    } {
        return {
            isRecording: this.isRecording,
            isConfigured: this.isConfigured,
            chunksProcessed: this.chunkIndex,
            filesUploaded: this.filesUploaded,
        }
    }

    public getFilesUploaded(): boolean {
        return this.filesUploaded
    }
    
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
        // Correction based on real observed results:
        // High load = audio ahead = need NEGATIVE offset or close to 0
        
        if (load < 1.5) {
            // Stable system: audio often ahead by ~65ms
            console.log('Stable system detected, applying negative offset for early audio')
            return -0.065  // Advance audio by 65ms (audio typically ahead)
        } else if (load < 2.5) {
            // Moderately loaded system: offset close to 0
            console.log('Moderate load detected, using minimal offset')
            return 0.000  // No offset
        } else {
            // Very loaded system: audio ahead, need to advance it more!
            console.log('High load detected, audio ahead - applying negative offset')
            return -0.050  // Advance audio by 50ms as it's ahead
        }
    }

    /**
     * Monitor chunk directory and auto-upload new chunks as they are created
     */
    private startRealtimeChunkMonitoring(chunksDir: string): void {
        const fs = require('fs')
        const path = require('path')
        
        console.log(`📁 Starting real-time chunk monitoring: ${chunksDir}`)
        
        // Watch the chunks directory for new files
        const watcher = fs.watch(chunksDir, { persistent: false }, async (eventType: string, filename: string) => {
            if (eventType === 'rename' && filename && filename.endsWith('.wav')) {
                const chunkPath = path.join(chunksDir, filename)
                
                // Wait a bit for the file to be fully written
                setTimeout(async () => {
                    try {
                        // Check if file exists and has content
                        if (fs.existsSync(chunkPath)) {
                            const stats = fs.statSync(chunkPath)
                            if (stats.size > 0) {
                                console.log(`🎯 New chunk detected: ${filename} (${stats.size} bytes)`)
                                await this.uploadChunkImmediately(chunkPath, filename)
                            }
                        }
                    } catch (error) {
                        console.error(`Error processing chunk ${filename}:`, error)
                    }
                }, 2000) // Wait 2s for file to be fully written
            }
        })
        
        // Store watcher to close it later
        this.chunkWatcher = watcher
    }

    /**
     * Upload a chunk file immediately to S3 and clean up
     */
    private async uploadChunkImmediately(chunkPath: string, filename: string): Promise<void> {
        if (!this.pathManager || !this.s3Uploader) {
            console.error('PathManager or S3Uploader not available for chunk upload')
            return
        }

        try {
            // Get the appropriate bucket based on environment
            const env = process.env.ENVIRON || 'local'
            const bucketName =
                this.config.transcriptionAudioBucket ||
                (env === 'prod'
                    ? 'meeting-baas-audio'
                    : env === 'preprod'
                      ? 'preprod-meeting-baas-audio'
                      : process.env.AWS_S3_TEMPORARY_AUDIO_BUCKET ||
                        'local-meeting-baas-audio')

            const botUuid = this.pathManager.getBotUuid()
            const s3Key = `${botUuid}/${filename}`

            console.log(`⬆️ Uploading chunk immediately: ${filename} to bucket ${bucketName}`)

            // Upload the chunk
            const url = await this.s3Uploader.uploadFile(
                chunkPath,
                bucketName,
                s3Key,
                true // deleteAfterUpload = true
            )
            
            console.log(`✅ Chunk uploaded and cleaned up: ${filename} → ${url}`)
        } catch (error) {
            console.error(`❌ Failed to upload chunk ${filename}:`, error)
        }
    }
}

// Instance globale unique (comme dans Transcoder.ts)
export const SCREEN_RECORDER = new ScreenRecorder({
    recordingMode: 'speaker_view',
    enableTranscriptionChunking: process.env.ENABLE_TRANSCRIPTION_CHUNKING === 'true',
    transcriptionAudioBucket: process.env.TRANSCRIPTION_AUDIO_BUCKET,
})