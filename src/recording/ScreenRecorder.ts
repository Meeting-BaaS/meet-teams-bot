import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'

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
            chunkDuration: 3000, // 3 secondes par chunk
            audioBitrate: '128k',
            videoBitrate: '1000k',
            ...config
        }
    }

    public async startRecording(onChunk: (chunk: Buffer, isFinal: boolean) => Promise<void>): Promise<void> {
        if (this.isRecording) {
            throw new Error('Recording is already in progress')
        }

        console.log('Starting screen recording with config:', this.config)

        // Créer un fichier temporaire pour la sortie
        this.outputPath = `/tmp/screen_recording_${Date.now()}.${this.config.outputFormat}`
        
        const ffmpegArgs = await this.buildFFmpegArgs()
        
        console.log('FFmpeg command:', 'ffmpeg', ffmpegArgs.join(' '))

        try {
            this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe']
            })

            this.isRecording = true
            this.lastChunkTime = Date.now()

            // Gérer les chunks en temps réel
            this.setupChunkHandling(onChunk)

            // Gérer les erreurs
            this.ffmpegProcess.on('error', (error) => {
                console.error('FFmpeg process error:', error)
                this.emit('error', error)
            })

            this.ffmpegProcess.on('exit', (code, signal) => {
                console.log(`FFmpeg process exited with code ${code} and signal ${signal}`)
                this.isRecording = false
                this.emit('stopped')
            })

            // Écouter stderr pour les logs FFmpeg
            this.ffmpegProcess.stderr?.on('data', (data) => {
                const output = data.toString()
                // Filtrer les logs utiles
                if (output.includes('fps=') || output.includes('time=')) {
                    console.log('FFmpeg progress:', output.trim())
                }
                if (output.includes('error') || output.includes('Error')) {
                    console.error('FFmpeg error:', output.trim())
                }
            })

            console.log('Screen recording started successfully')
            this.emit('started')

        } catch (error) {
            console.error('Failed to start screen recording:', error)
            this.isRecording = false
            throw error
        }
    }

    private async buildFFmpegArgs(): Promise<string[]> {
        const args: string[] = []

        // Input sources
        
        // 1. Video input (X11 screen capture)
        args.push(
            '-f', 'x11grab',
            '-video_size', `${this.config.width}x${this.config.height}`,
            '-framerate', '30',             // FORCE 30 fps en entrée
            '-probesize', '10M',            // Taille de probe pour détection
            '-thread_queue_size', '1024',   // Queue pour threads
            '-i', this.config.display
        )

        // 2. Audio input (PulseAudio)
        if (this.config.audioDevice) {
            args.push(
                '-f', 'pulse',
                '-i', 'default'
            )
        }

        // Video encoding settings optimisés pour lecture rapide
        if (this.config.outputFormat === 'mp4') {
            // H.264 pour MP4 - lecture plus rapide
            args.push(
                '-filter:v', `fps=${this.config.framerate}`,  // FORCE le framerate avec filtre
                '-c:v', 'libx264',
                '-preset', 'fast',          // Plus rapide que ultrafast pour la lecture
                '-tune', 'zerolatency',
                '-profile:v', 'main',       // Profile main pour compatibilité
                '-level:v', '3.1',          // Level pour web/mobile
                '-b:v', this.config.videoBitrate,
                '-maxrate', this.config.videoBitrate,
                '-bufsize', '2M',           // Buffer pour streaming
                '-g', this.config.framerate.toString(),  // GOP size = framerate
                '-keyint_min', this.config.framerate.toString(),  // Min keyframe interval
                '-sc_threshold', '0',       // Disable scene change detection
                '-pix_fmt', 'yuv420p'       // Compatible avec tous players
            )
        } else {
            // WebM/VP8 optimisé
            args.push(
                '-filter:v', `fps=${this.config.framerate}`,  // FORCE le framerate avec filtre
                '-c:v', 'libvpx',
                '-b:v', this.config.videoBitrate,
                '-preset', 'good',          // Bon compromis qualité/vitesse
                '-cpu-used', '2',           // Plus rapide que 0, moins que 4
                '-deadline', 'realtime',
                '-error-resilient', '1'
            )
        }

        // Audio encoding settings optimisés
        if (this.config.audioDevice) {
            args.push(
                '-c:a', 'aac',              // AAC plus compatible que opus
                '-b:a', this.config.audioBitrate,
                '-ar', '44100',             // Sample rate standard
                '-ac', '2',                 // Stereo
                '-profile:a', 'aac_low'     // Profile AAC optimal
            )
        }

        // Format et optimisations de streaming
        args.push(
            '-f', this.config.outputFormat,
            '-movflags', '+faststart',      // Métadonnées au début (lecture rapide)
            '-fflags', '+flush_packets',
            '-flags', '+global_header'
        )

        // Configuration pour les chunks temps réel
        if (this.config.outputFormat === 'webm') {
            args.push(
                '-cluster_time_limit', (this.config.chunkDuration).toString(),
                '-cluster_size_limit', '1M'  // Chunks plus petits
            )
        }

        // Synchronisation audio/vidéo optimisée
        args.push(
            '-async', '1',
            '-vsync', '1',
            '-avoid_negative_ts', 'make_zero'  // Éviter les timestamps négatifs
        )

        // Sortie vers stdout pour traitement en chunks
        args.push('pipe:1')

        return args
    }

    private setupChunkHandling(onChunk: (chunk: Buffer, isFinal: boolean) => Promise<void>): void {
        if (!this.ffmpegProcess?.stdout) {
            throw new Error('FFmpeg stdout not available')
        }

        let buffer = Buffer.alloc(0)
        let lastEmitTime = Date.now()

        this.ffmpegProcess.stdout.on('data', async (data: Buffer) => {
            buffer = Buffer.concat([buffer, data])

            const now = Date.now()
            const timeSinceLastEmit = now - lastEmitTime

            // Émettre un chunk toutes les `chunkDuration` millisecondes ou quand le buffer atteint une taille critique
            if (timeSinceLastEmit >= this.config.chunkDuration || buffer.length >= 1024 * 1024) { // 1MB
                if (buffer.length > 0) {
                    try {
                        console.log(`Emitting chunk ${this.chunkIndex++}: ${buffer.length} bytes after ${timeSinceLastEmit}ms`)
                        await onChunk(buffer, false)
                        buffer = Buffer.alloc(0)
                        lastEmitTime = now
                    } catch (error) {
                        console.error('Error processing chunk:', error)
                        this.emit('error', error)
                    }
                }
            }
        })

        this.ffmpegProcess.stdout.on('end', async () => {
            // Envoyer le chunk final s'il reste des données
            if (buffer.length > 0) {
                try {
                    console.log(`Emitting final chunk: ${buffer.length} bytes`)
                    await onChunk(buffer, true)
                } catch (error) {
                    console.error('Error processing final chunk:', error)
                }
            }
        })
    }

    public async stopRecording(): Promise<void> {
        if (!this.isRecording || !this.ffmpegProcess) {
            console.log('No recording in progress')
            return
        }

        console.log('Stopping screen recording...')

        return new Promise((resolve, reject) => {
            if (!this.ffmpegProcess) {
                resolve()
                return
            }

            const timeout = setTimeout(() => {
                console.log('FFmpeg did not exit gracefully, forcing kill')
                this.ffmpegProcess?.kill('SIGKILL')
                reject(new Error('Recording stop timeout'))
            }, 10000) // 10 seconds timeout

            this.ffmpegProcess.on('exit', () => {
                clearTimeout(timeout)
                this.isRecording = false
                console.log('Screen recording stopped successfully')
                
                // Nettoyer le fichier temporaire si il existe
                if (this.outputPath && fs.existsSync(this.outputPath)) {
                    fs.unlinkSync(this.outputPath)
                }
                
                resolve()
            })

            // Envoyer signal d'arrêt gracieux
            this.ffmpegProcess.stdin?.end()
            this.ffmpegProcess.kill('SIGTERM')
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
} 