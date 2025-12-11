import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import { Readable } from 'stream'
import { RawData, WebSocket } from 'ws'

import { SoundContext } from './media_context'
import { SpeakerData } from './types'
import { PathManager } from './utils/PathManager'
import { formatError } from './utils/Logger'

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

    // Browser audio streaming
    private sourceSampleRate: number = 48000 // Default, updated by incoming chunks
    private browserAudioChunksSent: number = 0
    private lastBrowserStatsLogTime: number = 0

    // WebSocket connection buffer (for chunks received before WS is ready)
    private connectionBuffer: Float32Array[] = []
    private readonly MAX_CONNECTION_BUFFER_SIZE: number = 100 // ~4 seconds at 24kHz
    private wsConnectionStartTime: number = 0

    // Debug: Save streamed audio to file
    private debugAudioStream: fs.WriteStream | null = null
    private debugAudioBytesWritten: number = 0
    private readonly debugAudioEnabled: boolean = false

    constructor(
        input: string | undefined,
        output: string | undefined,
        sample_rate: number | undefined,
        bot_id: string,
    ) {
        this.inputUrl = input
        this.outputUrl = output
        this.botId = bot_id

        if (sample_rate) {
            this.sample_rate = sample_rate
        }

        // Read debug audio configuration from environment variable
        ;(this as any).debugAudioEnabled = process.env.DEBUG_AUDIO === 'true'

        console.log(
            `🎵 Streaming service initialized with sample rate: ${this.sample_rate} Hz${sample_rate ? ' (from user config)' : ` (default: ${DEFAULT_SAMPLE_RATE} Hz)`}`,
        )
        if (this.debugAudioEnabled) {
            console.log('🐛 Debug audio file recording enabled (DEBUG_AUDIO=true)')
        }

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
            this.processBatchedAudio().catch((error) =>
                console.error('Error processing batched audio:', formatError(error)),
            )
            this.audioBuffer = []
        }

        // ❌ DISABLED: FFmpeg streaming disabled - now using browser WebRTC pipeline
        // Browser WebRTC provides <50ms latency vs FFmpeg's ~200-500ms
        // See processMixedAudioChunk() for the active streaming pipeline
        // this.forwardToExternalService(audioData)
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
     * 🚀 STREAMING: Process pre-mixed audio from Web Audio API
     * KISS approach: Browser mixes automatically, we just forward it!
     */
    public processMixedAudioChunk(audioChunk: {
        audioData: number[]
        sampleRate: number
        timestamp: number
        numberOfFrames: number
    }): void {
        if (!this.isInitialized) {
            console.warn('[Streaming] ⚠️ Received audio chunk but streaming not initialized')
            return
        }

        if (!this.output_ws || this.output_ws.readyState !== WebSocket.OPEN) {
            console.warn('[Streaming] ⚠️ Received audio chunk but WebSocket not open (state:', this.output_ws?.readyState, ')')
            return
        }

        try {
            const float32Data = new Float32Array(audioChunk.audioData)

            // Log first chunk received
            if (this.browserAudioChunksSent === 0) {
                console.log(`🎵 [Streaming] First audio chunk received from browser: ${audioChunk.numberOfFrames} frames @ ${audioChunk.sampleRate} Hz`)
            }

            // Update source sample rate
            if (audioChunk.sampleRate && audioChunk.sampleRate > 0) {
                if (this.sourceSampleRate !== audioChunk.sampleRate) {
                    console.log(`🎵 [Streaming] Web Audio mixer sample rate: ${audioChunk.sampleRate} Hz`)
                    this.sourceSampleRate = audioChunk.sampleRate
                }
            }

            // Send directly - no buffering, no manual mixing!
            this.processAndSendAudioChunk(float32Data)

            // Log stats every 5 seconds
            const now = Date.now()
            if (now - this.lastBrowserStatsLogTime > 5000) {
                console.log(`📊 [Streaming] Sent ${this.browserAudioChunksSent} audio chunks to WebSocket`)
                this.lastBrowserStatsLogTime = now
            }

        } catch (error) {
            console.error('[Streaming] Failed to process mixed audio chunk:', error)
        }
    }

    /**
     * Process and send a single audio chunk immediately
     */
    private processAndSendAudioChunk(audioData: Float32Array): void {
        // Simple clipping protection
        const normalized = new Float32Array(audioData.length)
        for (let i = 0; i < audioData.length; i++) {
            normalized[i] = Math.max(-1, Math.min(1, audioData[i]))
        }

        // Resample if needed (e.g. 48kHz -> 16kHz)
        const sourceRate = this.sourceSampleRate
        const targetRate = this.sample_rate
        let finalBuffer = normalized

        if (sourceRate !== targetRate) {
            const ratio = sourceRate / targetRate
            const newLength = Math.round(normalized.length / ratio)
            const resampled = new Float32Array(newLength)

            for (let i = 0; i < newLength; i++) {
                const sourceIndex = i * ratio
                const index = Math.floor(sourceIndex)
                const decimal = sourceIndex - index

                // Linear interpolation
                const p0 = normalized[index] || 0
                const p1 = normalized[index + 1] || p0
                resampled[i] = p0 + (p1 - p0) * decimal
            }
            finalBuffer = resampled
        }

        // Convert to Int16 for WebSocket transmission
        const s16Array = new Int16Array(finalBuffer.length)
        for (let i = 0; i < finalBuffer.length; i++) {
            s16Array[i] = Math.round(
                Math.max(-32768, Math.min(32767, finalBuffer[i] * 32768)),
            )
        }

        // Send to WebSocket
        if (this.output_ws && this.output_ws.readyState === WebSocket.OPEN) {
            this.output_ws.send(s16Array.buffer)
            this.browserAudioChunksSent++

            // Write to debug file
            this.writeDebugAudioChunk(s16Array)
        }
    }

    /**
     * Flush the connection buffer (send all buffered chunks)
     */
    private flushConnectionBuffer(): void {
        if (this.connectionBuffer.length === 0) {
            return
        }

        const bufferSize = this.connectionBuffer.length
        console.log(
            `📤 Flushing connection buffer: ${bufferSize} chunks (~${(bufferSize * 0.04).toFixed(2)}s of audio)`,
        )

        for (const chunk of this.connectionBuffer) {
            const s16Array = new Int16Array(chunk.length)
            for (let i = 0; i < chunk.length; i++) {
                s16Array[i] = Math.round(
                    Math.max(-32768, Math.min(32767, chunk[i] * 32768)),
                )
            }
            if (this.output_ws && this.output_ws.readyState === WebSocket.OPEN) {
                this.output_ws.send(s16Array.buffer)
            }
        }

        this.connectionBuffer = []
    }

    /**
     * Setup external output WebSocket (for external services)
     */
    private setupExternalOutputWS(): void {
        try {
            console.log(`🔌 Connecting to external output WebSocket: ${this.outputUrl}`)
            this.output_ws = new WebSocket(this.outputUrl!)
            this.wsConnectionStartTime = Date.now()

            this.output_ws.on('open', () => {
                const connectionTime = Date.now() - this.wsConnectionStartTime
                console.log(`✅ External output WebSocket connected in ${connectionTime}ms`)

                if (this.output_ws) {
                    const handshake = {
                        protocol_version: 1,
                        bot_id: this.botId,
                        offset: 0.0,
                        sample_rate: this.sample_rate,
                    }
                    console.log(`🤝 Sending handshake to ${this.outputUrl}: ${JSON.stringify(handshake)}`)
                    this.output_ws.send(JSON.stringify(handshake))

                    // Flush any buffered audio chunks
                    this.flushConnectionBuffer()

                    // Initialize debug audio file if enabled
                    if (this.debugAudioEnabled) {
                        this.initDebugAudioFile()
                    }
                }
            })

            this.output_ws.on('error', (err: Error) => {
                console.error('External output WebSocket error:', formatError(err))
            })

            this.output_ws.on('close', () => {
                console.log('External output WebSocket closed')
            })

            // Handle dual channel (input/output same URL)
            if (this.inputUrl === this.outputUrl) {
                this.play_incoming_audio_chunks(this.output_ws)
            }
        } catch (error) {
            console.error(
                'Failed to setup external output WebSocket:',
                formatError(error),
            )
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
                console.error('External input WebSocket error:', formatError(err))
            })

            this.play_incoming_audio_chunks(this.input_ws)
        } catch (error) {
            console.error(
                'Failed to setup external input WebSocket:',
                formatError(error),
            )
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

        // Finalize debug audio file
        this.finalizeDebugAudioFile()

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
            console.error(
                'Error closing external output WebSocket:',
                formatError(error),
            )
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
            console.error(
                'Error closing external input WebSocket:',
                formatError(error),
            )
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
                this.analyzeSoundLevel(f32Array).catch((error) =>
                    console.error('Error analyzing sound level:', formatError(error)),
                )

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

                    this.analyzeSoundLevel(f32Array).catch((error) =>
                        console.error(
                            'Error analyzing sound level:',
                            formatError(error),
                        ),
                    )
                    const buffer = Buffer.from(f32Array.buffer)
                    stream.push(buffer)
                } catch (error) {
                    console.error(
                        'Error processing external audio chunk:',
                        formatError(error),
                    )
                }
            }
        })

        return stream
    }

    /**
     * Initialize debug audio file for saving streamed audio
     */
    private initDebugAudioFile(): void {
        try {
            const debugPath = PathManager.getInstance().getDebugStreamedAudioPath()
            console.log(`🎤 Debug: Saving streamed audio to ${debugPath}`)

            this.debugAudioStream = fs.createWriteStream(debugPath)
            this.debugAudioBytesWritten = 0

            // Write WAV header (will be updated with correct size when closing)
            const header = this.createWavHeader(0, this.sample_rate, 1, 16)
            this.debugAudioStream.write(header)
        } catch (error) {
            console.error('Failed to initialize debug audio file:', error)
            this.debugAudioStream = null
        }
    }

    /**
     * Create WAV header
     */
    private createWavHeader(dataSize: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
        const header = Buffer.alloc(44)

        // RIFF header
        header.write('RIFF', 0)
        header.writeUInt32LE(36 + dataSize, 4) // File size - 8
        header.write('WAVE', 8)

        // fmt chunk
        header.write('fmt ', 12)
        header.writeUInt32LE(16, 16) // fmt chunk size
        header.writeUInt16LE(1, 20) // Audio format (1 = PCM)
        header.writeUInt16LE(channels, 22)
        header.writeUInt32LE(sampleRate, 24)
        header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28) // Byte rate
        header.writeUInt16LE(channels * bitsPerSample / 8, 32) // Block align
        header.writeUInt16LE(bitsPerSample, 34)

        // data chunk
        header.write('data', 36)
        header.writeUInt32LE(dataSize, 40)

        return header
    }

    /**
     * Write audio chunk to debug file
     */
    private writeDebugAudioChunk(audioData: Int16Array): void {
        if (!this.debugAudioStream) return

        try {
            const buffer = Buffer.from(audioData.buffer)
            this.debugAudioStream.write(buffer)
            this.debugAudioBytesWritten += buffer.length
        } catch (error) {
            console.error('Failed to write debug audio chunk:', error)
        }
    }

    /**
     * Finalize debug audio file (update WAV header with correct size)
     */
    private finalizeDebugAudioFile(): void {
        if (!this.debugAudioStream) return

        try {
            const debugPath = PathManager.getInstance().getDebugStreamedAudioPath()
            const bytesWritten = this.debugAudioBytesWritten
            const sampleRate = this.sample_rate

            this.debugAudioStream.end(async () => {
                let fd: fsPromises.FileHandle | null = null
                try {
                    // Update WAV header with correct size using async file operations
                    fd = await fsPromises.open(debugPath, 'r+')
                    const header = this.createWavHeader(bytesWritten, sampleRate, 1, 16)
                    await fd.write(header, 0, 44, 0)

                    console.log(`🎤 Debug: Streamed audio saved to ${debugPath} (${(bytesWritten / 1024).toFixed(1)} KB)`)
                } catch (error) {
                    console.error('Failed to update WAV header:', error)
                } finally {
                    // Always close the file descriptor
                    if (fd) {
                        try {
                            await fd.close()
                        } catch (closeError) {
                            console.error('Failed to close debug audio file:', closeError)
                        }
                    }
                }
            })
        } catch (error) {
            console.error('Failed to finalize debug audio file:', error)
        }

        this.debugAudioStream = null
        this.debugAudioBytesWritten = 0
    }

    public getCurrentSoundLevel(): number {
        return this.currentSoundLevel
    }
}
