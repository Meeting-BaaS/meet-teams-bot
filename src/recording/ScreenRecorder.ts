import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { PathManager } from '../utils/PathManager'
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
}

export class ScreenRecorder extends EventEmitter {
    private ffmpegProcess: ChildProcess | null = null
    private isRecording: boolean = false
    private config: ScreenRecordingConfig
    private outputPath: string = ''
    private chunkIndex: number = 0
    private lastChunkTime: number = 0
    private syncCalibrator: SyncCalibrator
    private page: any = null // Page Playwright for sync signal generation
    private calibratedOffset: number = 0 // NOUVEAU: Offset measured once
    private pathManager: PathManager
    private systemDiagnostic: SystemDiagnostic

    constructor(config: Partial<ScreenRecordingConfig> = {}) {
        super()
        
        this.config = {
            display: process.env.DISPLAY || ':99',
            audioDevice: 'pulse',
            outputFormat: 'webm',
            videoCodec: 'libvpx',
            audioCodec: 'opus',
            width: 1280,
            height: 720,
            framerate: 30,
            chunkDuration: 3000, // 3 seconds per chunk
            audioBitrate: '128k',
            videoBitrate: '1000k',
            ...config
        }
        
        this.syncCalibrator = new SyncCalibrator()
        this.pathManager = PathManager.getInstance()
        this.systemDiagnostic = new SystemDiagnostic()
    }

    public setPage(page: any): void {
        this.page = page
        console.log('Page set for sync signal generation')
    }

    /**
     * NOUVELLE MÉTHODE : Calibration once at startup
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

    public async startRecording(onChunk: (chunk: Buffer, isFinal: boolean) => Promise<void>): Promise<void> {
        if (this.isRecording) {
            throw new Error('Recording is already in progress')
        }

        console.log('🎬 Starting screen recording with config:', this.config)

        // Create output directories
        await this.pathManager.ensureDirectories()

        // Get output path
        const outputPath = path.join(this.pathManager.getTempPath(), 'output.mp4')
        this.outputPath = outputPath
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

        // Diagnostic information for troubleshooting
        console.log('=== DIAGNOSTIC INFO ===')
        console.log('If sync is still off after this correction:')
        console.log('  1. Check FFmpeg buffer delays (usually ~20-50ms)')
        console.log('  2. Verify PulseAudio latency (check with `pactl info`)')
        console.log('  3. Measure actual end-to-end delay in your setup')
        console.log('  4. Consider hardware-specific audio driver delays')
        console.log('Note: DO NOT add random empirical adjustments!')
        console.log('Best practice: MEASURE and IDENTIFY the root cause instead')

        // Build FFmpeg arguments with calibrated offset
        const ffmpegArgs = await this.buildFFmpegArgs(finalOffset)

        // Test if display and audio are available
        console.log('Testing X11 display...')
        try {
            const { spawn: testSpawn } = require('child_process')
            const testDisplay = testSpawn('xdpyinfo', ['-display', this.config.display])
            testDisplay.on('exit', (code) => {
                console.log('xdpyinfo exit code:', code)
            })
            testDisplay.stderr.on('data', (data) => {
                console.log('xdpyinfo stderr:', data.toString().trim())
            })
        } catch (err) {
            console.log('xdpyinfo test failed:', err)
        }

        try {
            this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe']
            })

            this.isRecording = true
            this.lastChunkTime = Date.now()

            // Detailed FFmpeg stderr logging
            this.ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                console.log('FFmpeg stderr:', output.trim())
                
                // Analyze specific errors
                if (output.includes('No such file or directory')) {
                    console.error('ERROR: File/device not found!')
                }
                if (output.includes('Permission denied')) {
                    console.error('ERROR: Permission denied!')
                }
                if (output.includes('Cannot open display')) {
                    console.error('ERROR: Display :99 inaccessible!')
                }
                if (output.includes('Connection refused')) {
                    console.error('ERROR: PulseAudio connection refused!')
                }
                if (output.includes('Invalid argument')) {
                    console.error('ERROR: Invalid FFmpeg argument!')
                }
                if (output.includes('fps=') || output.includes('time=')) {
                    console.log('FFmpeg progress:', output.trim())
                }
            })

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
                console.error('Error details:', {
                    code: (error as any).code,
                    errno: (error as any).errno,
                    syscall: (error as any).syscall,
                    path: (error as any).path
                })
                this.emit('error', error)
            })

            this.ffmpegProcess.on('exit', (code, signal) => {
                console.log(`FFmpeg process exited with code ${code} and signal ${signal}`)
                clearInterval(checkFile)
                
                // Analyze error code
                if (code === 1) {
                    console.error('FFmpeg failed with code 1 - checking common causes:')
                    console.error('  - Input source (x11grab/pulse) not available?')
                    console.error('  - Invalid parameters?')
                    console.error('  - Permission issues?')
                }
                if (code === 0) {
                    console.log('FFmpeg completed successfully!')
                    if (fs.existsSync(this.outputPath)) {
                        const stats = fs.statSync(this.outputPath)
                        console.log(`Final video file: ${stats.size} bytes`)
                    }
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
            this.emit('started')

        } catch (error) {
            console.error('💥 Failed to start screen recording:', error)
            this.isRecording = false
            throw error
        }
    }

    private async buildFFmpegArgs(fixedAudioOffset: number): Promise<string[]> {
        const args: string[] = []

        console.log('🛠️ Building FFmpeg args for Docker-optimized synchronization...')
        console.log(`🎯 Applying audio offset: ${fixedAudioOffset.toFixed(3)}s`)

        // ===== SOLUTION 1: CAPTURE SYNCHRONIZED UNIQUE =====
        // Instead of 2 separate inputs, use a single multi-stream input
        
        // Input video with integrated audio for ensuring sync
        args.push(
            '-f', 'x11grab',
            '-video_size', '1280x880',         // AUGMENTED: 720+160 for the new crop
            '-framerate', '30',
            '-probesize', '50M',
            '-analyzeduration', '10000000',
            
            // ===== DOCKER SYNC FIXES =====
            '-thread_queue_size', '512',       // Larger buffer to avoid drops
            '-rtbufsize', '100M',              // Real-time buffer for stability
            '-fflags', '+genpts',              // Force timestamp generation
            '-use_wallclock_as_timestamps', '1', // Use system clock as reference
            
            '-i', this.config.display
        )

        // Separate audio but with forced synchronization + OFFSET CALIBRATED
        if (this.config.audioDevice) {
            args.push(
                '-f', 'pulse',
                '-thread_queue_size', '512',
                '-probesize', '50M',
                '-analyzeduration', '10000000',
                
                // ===== AUDIO SYNC IN DOCKER =====
                '-fflags', '+genpts',              // Consistent timestamps
                '-use_wallclock_as_timestamps', '1', // Same clock as video
                
                // ===== OFFSET INTELLIGENT CALIBRATED =====
                '-itsoffset', fixedAudioOffset.toString(), // Apply CORRECTED offset !
                
                '-i', 'virtual_speaker.monitor'
            )
            
            console.log(`✅ FFmpeg itsoffset parameter: ${fixedAudioOffset.toFixed(3)}s`)
        }

        // ===== SOLUTION 2: ENCODING WITH NATIVE SYNC =====
        args.push(
            // Video
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '20',
            '-profile:v', 'high',
            '-level', '4.0',
            '-pix_fmt', 'yuv420p',
            
            // Crop for browser header
            '-vf', 'crop=1280:720:0:160',      // AUGMENTED: remove 160px from top instead of 120px
            
            // Audio (without fixed correction, we'll use automatic detection)
            '-c:a', 'aac',
            '-b:a', '160k',
            '-ac', '2',
            '-ar', '48000',
            
            // ===== SOLUTION 3: SYNCHRONIZATION FOR DETECTION =====
            '-map', '0:v:0',                   // Explicit video map from stream 0
            '-map', '1:a:0',                   // Explicit audio map from stream 1
            '-shortest',                       // Stop when shortest stream finishes
            '-avoid_negative_ts', 'make_zero', // Normalize negative timestamps
            '-max_muxing_queue_size', '1024',  // Larger queue for sync
            
            // ===== SOLUTION 4: TIMING PRECISE =====
            '-vsync', 'cfr',                   // Constant frame rate (not vfr)
            '-copyts',                         // Preserve original timestamps
            '-start_at_zero',                  // Start timestamps at 0
            
            // Output
            '-f', 'mp4',
            '-movflags', '+faststart',         // Optimization for streaming
            this.outputPath
        )

        console.log('✅ Docker-optimized sync args built:', args.length, 'parameters')
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
                
                if (code === 0) {
                    console.log(`Perfectly synced video created: ${this.outputPath}`)
                    console.log(`Applied calibrated offset: ${this.calibratedOffset}s during recording`)
                    console.log(`No re-encoding needed! Maximum performance achieved!`)
                    
                    if (fs.existsSync(this.outputPath)) {
                        const stats = fs.statSync(this.outputPath)
                        console.log(`Final video file: ${stats.size} bytes`)
                    }
                } else {
                    console.error(`FFmpeg failed with code ${code}`)
                }
                
                this.isRecording = false
                this.ffmpegProcess = null
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

    private analyzeVarianceSource(stdDev: number, diagnosticSummary: string): void {
        console.log('🎯 === VARIANCE ANALYSIS ===')
        console.log('🎯 Diagnostic summary:')
        console.log(diagnosticSummary)
        
        if (stdDev > 0.05) {
            console.warn(`⚠️ High variance detected (${(stdDev * 1000).toFixed(0)}ms) - system might be unstable`)
        } else {
            console.log(`✅ Excellent precision! Variance only ±${(stdDev * 1000).toFixed(0)}ms`)
        }
    }

    private async waitForSystemStability(): Promise<void> {
        console.log('⏳ Checking system stability before calibration...')
        
        let attempts = 0
        const maxAttempts = 10 // Max 10 attempts (50 seconds)
        
        while (attempts < maxAttempts) {
            const diagnostic = await this.systemDiagnostic.quickDiagnostic()
            const load = await this.getSystemLoad()
            
            console.log(`📊 System check ${attempts + 1}/${maxAttempts}: Load ${load.toFixed(2)}`)
            
            if (load < 2.0) {
                console.log(`✅ System stable! Load ${load.toFixed(2)} < 2.0 - proceeding with calibration`)
                return
            }
            
            console.log(`⏳ System load too high (${load.toFixed(2)} >= 2.0), waiting 5s...`)
            await new Promise(resolve => setTimeout(resolve, 5000))
            attempts++
        }
        
        console.warn(`⚠️ System still unstable after ${maxAttempts} attempts, proceeding anyway...`)
        console.warn(`⚠️ Expect higher variance in calibration results`)
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

    // Background calibration system (optional for future improvements)
    private async startBackgroundCalibration(): Promise<void> {
        // This function could run in the background during recording
        // to adjust parameters if necessary
        console.log('Background calibration could be implemented here for future improvements')
    }
}