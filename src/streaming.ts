import * as fs from 'fs'
import { Readable } from 'stream'
import { RawData, WebSocket } from 'ws'

import { SoundContext } from './media_context'
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

    // Browser audio mixing (combine multiple tracks into one stream)
    private browserAudioMixer: Map<number, Float32Array> = new Map() // timestamp -> mixed audio
    private lastMixerFlushTime: number = 0
    private readonly MIXER_WINDOW_MS: number = 20 // Mix chunks within 20ms windows
    private sourceSampleRate: number = 44100 // Default to 48k, updated by incoming chunks

    // Latency monitoring (minimal overhead)
    private latencyMeasurements: number[] = []
    private lastLatencyLogTime: number = 0
    private readonly LATENCY_LOG_INTERVAL_MS: number = 10000 // Log every 10s

    // WebSocket connection buffer (for chunks received before WS is ready)
    private connectionBuffer: Float32Array[] = []
    private readonly MAX_CONNECTION_BUFFER_SIZE: number = 100 // ~4 seconds at 24kHz
    private wsConnectionStartTime: number = 0

    // Statistics tracking
    private audioPacketsReceived: number = 0
    private lastStatsLogTime: number = 0
    private readonly STATS_LOG_INTERVAL_MS: number = 15000
    private browserAudioPacketsReceived: number = 0
    private browserAudioChunksSent: number = 0
    private lastBrowserStatsLogTime: number = 0

    // Debug: Save streamed audio to file
    private debugAudioStream: fs.WriteStream | null = null
    private debugAudioBytesWritten: number = 0

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

        console.log(
            `🎵 Streaming service initialized with sample rate: ${this.sample_rate} Hz${sample_rate ? ' (from user config)' : ` (default: ${DEFAULT_SAMPLE_RATE} Hz)`}`,
        )

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

        // if (this.isPaused) {
        //     // If paused, store chunks for later processing
        //     const buffer = Buffer.from(audioData.buffer)
        //     this.pausedChunks.push(buffer)
        //     return
        // }

        // ❌ DISABLED: FFmpeg streaming disabled - now using browser WebRTC pipeline
        // Browser WebRTC provides <50ms latency vs FFmpeg's ~200-500ms
        // See processBrowserAudioChunk() for the active streaming pipeline
        // this.forwardToExternalService(audioData)

        // Buffer audio for batch processing (sound level analysis)
        // This batching only affects analysis, not real-time streaming
        this.audioBuffer.push(audioData)
        if (this.audioBuffer.length >= this.AUDIO_BUFFER_SIZE) {
            this.processBatchedAudio().catch(console.error)
            this.audioBuffer = []
        }

        // Log stats periodically (moved to end to avoid blocking)
        const now = Date.now()
        if (now - this.lastStatsLogTime >= this.STATS_LOG_INTERVAL_MS) {
            const packetsInInterval = this.audioPacketsReceived
            console.log(
                `🎵 Direct audio packets processed: ${packetsInInterval} in last ${this.STATS_LOG_INTERVAL_MS}ms`,
            )
            this.audioPacketsReceived = 0
            this.lastStatsLogTime = now
        }
    }

    /**
     * 🚀 ULTRA-LOW LATENCY: Process audio chunk directly from browser WebRTC
     * This bypasses FFmpeg entirely, providing <50ms latency streaming
     * 
     * MIXING STRATEGY:
     * - Buffers chunks from multiple speakers within 20ms time windows
     * - Mixes all chunks in each window into a single stream
     * - Sends mixed stream to WebSocket (simpler for receiving end)
     */
    public processBrowserAudioChunk(audioChunk: {
        audioData: number[]
        sampleRate: number
        timestamp: number
        numberOfFrames: number
        ssrc: any
        deviceId: string | null
        userName: string | null
    }): void {
        if (!this.isInitialized) {
            console.warn('🔴 processBrowserAudioChunk called but not initialized')
            return
        }

        if (!this.output_ws || this.output_ws.readyState !== WebSocket.OPEN) {
            return // No WebSocket or not ready
        }

        // Increment packet counter for stats
        this.browserAudioPacketsReceived++

        try {
            // Convert number[] to Float32Array
            const float32Data = new Float32Array(audioChunk.audioData)

            // Log raw audio amplitude occasionally for debugging
            if (Math.random() < 0.01) { // Log 1% of chunks
                let peak = 0
                for (let i = 0; i < float32Data.length; i++) {
                    peak = Math.max(peak, Math.abs(float32Data[i]))
                }
                const userName = audioChunk.userName || 'Unknown'
                const ssrc = audioChunk.ssrc || 'N/A'
                console.log(`📊 Raw audio from ${userName} (SSRC: ${ssrc}): peak=${peak.toFixed(6)} (normal speech: 0.01-1.0)`)
            }

            // Update source sample rate from the chunk if available
            if (audioChunk.sampleRate && audioChunk.sampleRate > 0) {
                if (this.sourceSampleRate !== audioChunk.sampleRate) {
                    console.log(`🎵 Detected browser audio sample rate: ${audioChunk.sampleRate} Hz (was ${this.sourceSampleRate} Hz)`)
                    this.sourceSampleRate = audioChunk.sampleRate
                }
            }

            // Use timestamp rounded to 20ms windows for mixing
            const timeWindow = Math.floor(audioChunk.timestamp / 20000) * 20000

            // Get or create mixed buffer for this time window
            let mixedBuffer = this.browserAudioMixer.get(timeWindow)
            if (!mixedBuffer) {
                mixedBuffer = new Float32Array(float32Data.length).fill(0)
                this.browserAudioMixer.set(timeWindow, mixedBuffer)
            }

            // Mix this chunk into the buffer (simple addition)
            for (let i = 0; i < Math.min(float32Data.length, mixedBuffer.length); i++) {
                mixedBuffer[i] += float32Data[i]
            }

            // Flush mixer periodically (every 20ms)
            const now = Date.now()
            if (now - this.lastMixerFlushTime >= this.MIXER_WINDOW_MS) {
                this.flushMixer()
                this.lastMixerFlushTime = now
            }

        } catch (error) {
            console.error('Failed to process browser audio chunk:', error)
        }

        // Log stats periodically
        const now = Date.now()
        if (now - this.lastBrowserStatsLogTime >= this.STATS_LOG_INTERVAL_MS) {
            const packetsInInterval = this.browserAudioPacketsReceived
            const chunksSent = this.browserAudioChunksSent
            console.log(
                `🎵 Browser audio: ${packetsInInterval} packets received, ${chunksSent} chunks sent (${this.sourceSampleRate}Hz -> ${this.sample_rate}Hz)`,
            )
            this.browserAudioPacketsReceived = 0
            this.browserAudioChunksSent = 0
            this.lastBrowserStatsLogTime = now
        }
    }

    /**
     * Flush the audio mixer - send all mixed buffers to WebSocket
     */
    private flushMixer(): void {
        if (this.browserAudioMixer.size === 0) {
            return
        }

        // Sort by timestamp (oldest first)
        const sortedWindows = Array.from(this.browserAudioMixer.entries())
            .sort(([a], [b]) => a - b)

        for (const [timestamp, mixedBuffer] of sortedWindows) {
            // Measure latency (WebRTC timestamp to send time)
            const sendTime = Date.now()
            const latencyMs = sendTime - (timestamp / 1000) // timestamp is in microseconds

            // Track latency (keep last 50 measurements for rolling average)
            this.latencyMeasurements.push(latencyMs)
            if (this.latencyMeasurements.length > 50) {
                this.latencyMeasurements.shift()
            }

            // Log average latency every 10 seconds
            if (sendTime - this.lastLatencyLogTime >= this.LATENCY_LOG_INTERVAL_MS) {
                const avgLatency = this.latencyMeasurements.reduce((a, b) => a + b, 0) / this.latencyMeasurements.length
                console.log(
                    `⚡ Browser audio latency: avg ${avgLatency.toFixed(1)}ms (last 50 chunks)`
                )
                this.lastLatencyLogTime = sendTime
            }

            // Calculate peak amplitude for dynamic gain
            let peak = 0
            for (let i = 0; i < mixedBuffer.length; i++) {
                peak = Math.max(peak, Math.abs(mixedBuffer[i]))
            }

            // Apply dynamic gain control
            // Target peak is 0.7 to leave headroom, with safety divider of 3 for multiple speakers
            const targetPeak = 0.7
            const safetyDivider = 3
            let gain = peak > 0 ? Math.min(targetPeak / peak, safetyDivider) : safetyDivider

            // Log gain occasionally for debugging
            if (Math.random() < 0.01) { // Log 1% of chunks
                console.log(`🔊 AGC: peak=${peak.toFixed(4)}, gain=${gain.toFixed(2)}x`)
            }

            // Normalize with dynamic gain
            const normalized = new Float32Array(mixedBuffer.length)
            for (let i = 0; i < mixedBuffer.length; i++) {
                normalized[i] = Math.max(-1, Math.min(1, mixedBuffer[i] * gain))
            }

            // Resample if needed (e.g. 48kHz -> 16kHz)
            // Use the actual source rate detected from browser chunks
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

            // Send mixed chunk
            this.output_ws?.send(s16Array.buffer)
            this.browserAudioChunksSent++

            // Write to debug file
            this.writeDebugAudioChunk(s16Array)
        }

        // Clear mixer
        this.browserAudioMixer.clear()
    }


    /**
     * Forward audio to external services (if any)
     */
    private forwardToExternalService(audioData: Float32Array): void {
        if (!this.output_ws) {
            return // No WebSocket configured
        }

        if (this.output_ws.readyState === WebSocket.OPEN) {
            // WebSocket is ready - send immediately
            this.sendAudioChunk(audioData)
        } else if (this.output_ws.readyState === WebSocket.CONNECTING) {
            // WebSocket is still connecting - buffer the chunk
            if (this.connectionBuffer.length < this.MAX_CONNECTION_BUFFER_SIZE) {
                this.connectionBuffer.push(audioData)
            } else {
                // Buffer is full - drop oldest chunk and add new one
                this.connectionBuffer.shift()
                this.connectionBuffer.push(audioData)
                console.warn(
                    `⚠️ Connection buffer full (${this.MAX_CONNECTION_BUFFER_SIZE} chunks), dropping oldest chunk`,
                )
            }
        }
        // If CLOSED or CLOSING, chunks are dropped (expected behavior)
    }

    /**
     * Send a single audio chunk to the WebSocket
     */
    private sendAudioChunk(audioData: Float32Array): void {
        if (!this.output_ws || this.output_ws.readyState !== WebSocket.OPEN) {
            return
        }

        // Convert f32Array to s16Array for external services
        const s16Array = new Int16Array(audioData.length)
        for (let i = 0; i < audioData.length; i++) {
            s16Array[i] = Math.round(
                Math.max(-32768, Math.min(32767, audioData[i] * 32768)),
            )
        }
        this.output_ws.send(s16Array.buffer)
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
            this.sendAudioChunk(chunk)
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

                    // Initialize debug audio file
                    this.initDebugAudioFile()
                }
            })

            this.output_ws.on('error', (err: Error) => {
                console.error(`External output WebSocket error: ${err}`)
            })

            this.output_ws.on('close', () => {
                console.log('External output WebSocket closed')
                // Clear connection buffer on close
                this.connectionBuffer = []
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
                fs.promises.appendFile(soundLogPath, logEntry).catch(() => { })
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
            read() { },
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
            this.debugAudioStream.end(() => {
                // Update WAV header with correct size
                const fd = fs.openSync(debugPath, 'r+')
                const header = this.createWavHeader(this.debugAudioBytesWritten, this.sample_rate, 1, 16)
                fs.writeSync(fd, header, 0, 44, 0)
                fs.closeSync(fd)

                console.log(`🎤 Debug: Streamed audio saved to ${debugPath} (${(this.debugAudioBytesWritten / 1024).toFixed(1)} KB)`)
            })
        } catch (error) {
            console.error('Failed to finalize debug audio file:', error)
        }

        this.debugAudioStream = null
        this.debugAudioBytesWritten = 0
    }
}
