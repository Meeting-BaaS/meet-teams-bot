import * as fs from 'fs'
import { Readable } from 'stream'
import { RawData, WebSocket } from 'ws'

import { SoundContext } from './media_context'
import { GLOBAL } from './singleton'
import { SpeakerData } from './types'
import { PathManager } from './utils/PathManager'

const DEFAULT_SAMPLE_RATE: number = 24_000

/**
 * Simplified Streaming class - Chrome Extension WebSocket logic removed
 * Now uses direct audio processing via processAudioChunk() from ScreenRecorder
 */
export class Streaming {
    public static instance: Streaming | null = null

    // External services WebSockets (kept for backward compatibility)
    private output_ws: WebSocket | null = null // For external audio output services
    private input_ws: WebSocket | null = null // For external audio input services
    private sample_rate: number = DEFAULT_SAMPLE_RATE

    // Configuration parameters
    private inputUrl: string | undefined
    private outputUrl: string | undefined
    private botId: string

    // Streaming state management
    private isInitialized: boolean = false
    private isPaused: boolean = false
    private pausedChunks: RawData[] = []

    // Audio level monitoring with performance optimizations
    private currentSoundLevel: number = 0
    private lastSoundLogTime_ms: number = 0
    private readonly SOUND_LOG_INTERVAL_MS: number = 5000
    private audioBuffer: Float32Array[] = [] // Buffer for batch processing
    private readonly AUDIO_BUFFER_SIZE: number = 12

    // Statistics tracking
    private audioPacketsReceived: number = 0
    private lastStatsLogTime: number = 0
    private readonly STATS_LOG_INTERVAL_MS: number = 15000

    constructor(
    ) {
        this.inputUrl = GLOBAL.get().streaming_input
        this.outputUrl = GLOBAL.get().streaming_output
        this.botId = GLOBAL.get().bot_uuid
        this.sample_rate = GLOBAL.get().streaming_audio_frequency || DEFAULT_SAMPLE_RATE
        
        this.audioPacketsReceived = 0

        this.start()

        Streaming.instance = this
    }

    /**
     * Simplified start method - only handles external services
     * No more Chrome Extension WebSocket server !
     */
    public start(): void {
        if (this.isInitialized) {
            console.warn('Streaming service already started')
            return
        }

        console.log(
            '🎵 Starting simplified streaming service (direct audio processing)',
        )

        // Setup external output WebSocket if configured
        if (this.outputUrl) {
            this.setupExternalOutputWS()
        }

        // Setup external input WebSocket if configured
        if (this.inputUrl && this.outputUrl !== this.inputUrl) {
            this.setupExternalInputWS()
        }

        this.isInitialized = true
        this.isPaused = false

        console.log('✅ Streaming service ready for direct audio processing')
    }

    /**
     * ⭐ MAIN METHOD: Process audio chunk directly from ScreenRecorder
     * This replaces the old Chrome Extension WebSocket approach
     */
    public processAudioChunk(audioData: Float32Array): void {
        if (!this.isInitialized) {
            return
        }

        // Increment packet counter for stats
        this.audioPacketsReceived++

        // Log stats periodically
        const now = Date.now()
        if (now - this.lastStatsLogTime >= this.STATS_LOG_INTERVAL_MS) {
            const packetsInInterval = this.audioPacketsReceived
            console.log(
                `🎵 Direct audio packets processed: ${packetsInInterval} in last ${this.STATS_LOG_INTERVAL_MS}ms`,
            )
            this.audioPacketsReceived = 0
            this.lastStatsLogTime = now
        }

        if (this.isPaused) {
            // If paused, store chunks for later processing
            const buffer = Buffer.from(audioData.buffer)
            this.pausedChunks.push(buffer)
            return
        }

        // Buffer audio for batch processing (sound level analysis)
        this.audioBuffer.push(audioData)
        if (this.audioBuffer.length >= this.AUDIO_BUFFER_SIZE) {
            this.processBatchedAudio().catch(console.error)
            this.audioBuffer = []
        }

        // Forward to external output service if connected
        this.forwardToExternalService(audioData)
    }

    /**
     * Forward audio to external services (if any)
     */
    private forwardToExternalService(audioData: Float32Array): void {
        if (this.output_ws && this.output_ws.readyState === WebSocket.OPEN) {
            // Convert f32Array to s16Array for external services
            const s16Array = new Int16Array(audioData.length)
            for (let i = 0; i < audioData.length; i++) {
                s16Array[i] = Math.round(
                    Math.max(-32768, Math.min(32767, audioData[i] * 32768)),
                )
            }
            this.output_ws.send(s16Array.buffer)
        }
    }

    /**
     * Setup external output WebSocket (for external services)
     */
    private setupExternalOutputWS(): void {
        try {
            this.output_ws = new WebSocket(this.outputUrl!)

            this.output_ws.on('open', () => {
                if (this.output_ws) {
                    this.output_ws.send(
                        JSON.stringify({
                            protocol_version: 1,
                            bot_id: this.botId,
                            offset: 0.0,
                        }),
                    )
                    console.log('✅ External output WebSocket connected')
                }
            })

            this.output_ws.on('error', (err: Error) => {
                console.error(`External output WebSocket error: ${err}`)
            })

            this.output_ws.on('close', () => {
                console.log('External output WebSocket closed')
            })

            // Handle dual channel (input/output same URL)
            if (this.inputUrl === this.outputUrl) {
                this.play_incoming_audio_chunks(this.output_ws)
            }
        } catch (error) {
            console.error(`Failed to setup external output WebSocket: ${error}`)
        }
    }

    /**
     * Setup external input WebSocket (for external services)
     */
    private setupExternalInputWS(): void {
        try {
            this.input_ws = new WebSocket(this.inputUrl!)

            this.input_ws.on('open', () => {
                console.log('✅ External input WebSocket connected')
            })

            this.input_ws.on('error', (err: Error) => {
                console.error(`External input WebSocket error: ${err}`)
            })

            this.play_incoming_audio_chunks(this.input_ws)
        } catch (error) {
            console.error(`Failed to setup external input WebSocket: ${error}`)
        }
    }

    public pause(): void {
        if (!this.isInitialized) {
            console.warn('Cannot pause: streaming service not started')
            return
        }

        if (this.isPaused) {
            console.warn('Streaming service already paused')
            return
        }

        this.isPaused = true
        console.log('🔇 Streaming paused')
    }

    public resume(): void {
        if (!this.isInitialized) {
            console.warn('Cannot resume: streaming service not started')
            return
        }

        if (!this.isPaused) {
            console.warn('Streaming service not paused')
            return
        }

        this.isPaused = false
        this.processPausedChunks()
        console.log('🔊 Streaming resumed')
    }

    /**
     * Simplified stop method - no more extension WebSocket cleanup
     */
    public stop(): void {
        if (!this.isInitialized) {
            console.warn('Cannot stop: streaming service not started')
            return
        }

        console.log('🛑 Stopping simplified streaming service...')

        // Close external WebSockets only
        this.closeExternalWebSockets()

        // Reset state
        this.isInitialized = false
        this.isPaused = false
        this.pausedChunks = []
        Streaming.instance = null

        console.log('✅ Streaming service stopped successfully')
    }

    private closeExternalWebSockets(): void {
        // Close external output WebSocket
        try {
            if (this.output_ws) {
                if (
                    this.output_ws.readyState === WebSocket.OPEN ||
                    this.output_ws.readyState === WebSocket.CONNECTING
                ) {
                    this.output_ws.close()
                }
                this.output_ws = null
            }
        } catch (error) {
            console.error('Error closing external output WebSocket:', error)
            this.output_ws = null
        }

        // Close external input WebSocket
        try {
            if (this.input_ws) {
                if (
                    this.input_ws.readyState === WebSocket.OPEN ||
                    this.input_ws.readyState === WebSocket.CONNECTING
                ) {
                    this.input_ws.close()
                }
                this.input_ws = null
            }
        } catch (error) {
            console.error('Error closing external input WebSocket:', error)
            this.input_ws = null
        }
    }

    public send_speaker_state(speakers: SpeakerData[]): void {
        if (!this.isInitialized || !this.outputUrl) {
            return
        }

        if (this.isPaused) {
            return
        }

        if (this.output_ws?.readyState === WebSocket.OPEN) {
            this.output_ws.send(JSON.stringify(speakers))
        }
    }

    /**
     * Process batched audio data for sound level analysis
     */
    private async processBatchedAudio(): Promise<void> {
        if (this.audioBuffer.length === 0) return

        // Combine all audio buffers into one for analysis
        const totalLength = this.audioBuffer.reduce(
            (sum, buffer) => sum + buffer.length,
            0,
        )
        const combinedBuffer = new Float32Array(totalLength)

        let offset = 0
        for (const buffer of this.audioBuffer) {
            combinedBuffer.set(buffer, offset)
            offset += buffer.length
        }

        // Analyze the combined buffer
        await this.analyzeSoundLevel(combinedBuffer)
    }

    /**
     * Audio level analysis (unchanged)
     */
    private async analyzeSoundLevel(audioData: Float32Array): Promise<void> {
        // Apply adaptive sampling to reduce computational load
        const sampleRate = audioData.length > 2000 ? 16 : 8
        const sampledLength = Math.floor(audioData.length / sampleRate)

        // Skip analysis for very small buffers
        if (sampledLength < 10) {
            return
        }

        let sum = 0

        // Calculate RMS (Root Mean Square)
        for (let i = 0; i < sampledLength; i++) {
            const value = audioData[i * sampleRate]
            sum += value * value
        }

        const rms = Math.sqrt(sum / sampledLength)

        // Calculate normalized sound level
        let normalizedLevel = 0
        if (rms > 0.005) {
            normalizedLevel = Math.min(100, rms * 300)
        }

        // Update current level for real-time monitoring
        this.currentSoundLevel = normalizedLevel

        // Throttled file logging
        const now = Date.now()
        if (now - this.lastSoundLogTime_ms >= this.SOUND_LOG_INTERVAL_MS) {
            const timestamp = new Date(now).toISOString()
            const logEntry = `${timestamp},${normalizedLevel.toFixed(0)}\n`

            try {
                const soundLogPath = PathManager.getInstance().getSoundLogPath()
                fs.promises.appendFile(soundLogPath, logEntry).catch(() => {})
                this.lastSoundLogTime_ms = now
            } catch (error) {
                // Silently handle file errors
            }
        }
    }

    private processPausedChunks(): void {
        if (this.pausedChunks.length === 0) {
            return
        }

        for (const message of this.pausedChunks) {
            if (message instanceof Buffer) {
                const uint8Array = new Uint8Array(message)
                const f32Array = new Float32Array(uint8Array.buffer)
                this.analyzeSoundLevel(f32Array).catch(console.error)

                // Forward to external services if needed
                if (
                    this.output_ws &&
                    this.output_ws.readyState === WebSocket.OPEN
                ) {
                    const s16Array = new Int16Array(f32Array.length)
                    for (let i = 0; i < f32Array.length; i++) {
                        s16Array[i] = Math.round(
                            Math.max(
                                -32768,
                                Math.min(32767, f32Array[i] * 32768),
                            ),
                        )
                    }
                    this.output_ws.send(s16Array.buffer)
                }
            }
        }

        this.pausedChunks = []
    }

    // External audio injection (kept for backward compatibility)
    private play_incoming_audio_chunks = (input_ws: WebSocket) => {
        new SoundContext(this.sample_rate)
        let stdin = SoundContext.instance.play_stdin()
        let audio_stream = this.createAudioStreamFromWebSocket(input_ws)

        audio_stream.on('data', (chunk) => {
            stdin.write(chunk)
        })

        audio_stream.on('end', () => {
            stdin.end()
        })
    }

    private createAudioStreamFromWebSocket = (input_ws: WebSocket) => {
        const stream = new Readable({
            read() {},
        })

        input_ws.on('message', (message: RawData) => {
            if (this.isPaused) {
                return
            }

            if (message instanceof Buffer) {
                const uint8Array = new Uint8Array(message)
                try {
                    const s16Array = new Int16Array(uint8Array.buffer)
                    const f32Array = new Float32Array(s16Array.length)
                    for (let i = 0; i < s16Array.length; i++) {
                        f32Array[i] = s16Array[i] / 32768
                    }

                    this.analyzeSoundLevel(f32Array).catch(console.error)
                    const buffer = Buffer.from(f32Array.buffer)
                    stream.push(buffer)
                } catch (error) {
                    console.error(
                        'Error processing external audio chunk:',
                        error,
                    )
                }
            }
        })

        return stream
    }

    public getCurrentSoundLevel(): number {
        return this.currentSoundLevel
    }
}
