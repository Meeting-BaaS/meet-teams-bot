import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import { Readable } from 'stream'
import { RawData, WebSocket } from 'ws'

import { SoundContext } from './media_context'
import { SpeakerData } from './types'
import { PathManager } from './utils/PathManager'
import { formatError } from './utils/Logger'

const DEFAULT_SAMPLE_RATE: number = 24_000

// Memory monitoring thresholds (in MB)
const MEMORY_WARNING_THRESHOLD_MB = 1200 // 1.2 GB - warn
const MEMORY_CRITICAL_THRESHOLD_MB = 1600 // 1.6 GB - critical alert
const MEMORY_CHECK_INTERVAL_MS = 30000 // Check every 30 seconds

// Connection buffer limits
const MAX_CONNECTION_BUFFER_SIZE = 500 // ~20 seconds of audio at 25 chunks/sec
const MAX_CONNECTION_BUFFER_DURATION_MS = 30000 // Max 30 seconds of buffered audio

/**
 * Streaming class for real-time audio output to external services
 * 
 * IMPORTANT: This is now an OPTIONAL feature, completely independent of:
 * - Sound level monitoring (handled by SoundLevelMonitor)
 * - Automatic leave detection (uses SoundLevelMonitor)
 * - Recording (handled by ScreenRecorder)
 * 
 * Audio sources:
 * - Browser Web Audio API (processMixedAudioChunk) - ultra-low latency streaming
 * - External WebSocket input (for bidirectional audio)
 * 
 * Note: processAudioChunk() is deprecated and no longer used for streaming
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


    // Browser audio streaming
    private sourceSampleRate: number = 48000 // Default, updated by incoming chunks
    private browserAudioChunksSent: number = 0
    private lastBrowserStatsLogTime: number = 0

    // WebSocket connection buffer (for chunks received before WS is ready)
    // Now with size limit and FIFO behavior to prevent memory leaks
    private connectionBuffer: Float32Array[] = []
    private connectionBufferStartTime: number = 0 // Track when buffering started
    private wsConnectionStartTime: number = 0

    // WebSocket reconnection with exponential backoff
    private isReconnecting: boolean = false
    private reconnectAttempts: number = 0
    private lastReconnectAttemptTime: number = 0
    private reconnectTimeoutId: NodeJS.Timeout | null = null
    private readonly INITIAL_RECONNECT_DELAY_MS: number = 1000 // 1 second
    private readonly MAX_RECONNECT_DELAY_MS: number = 60000 // 1 minute
    private readonly WS_NOT_READY_LOG_INTERVAL_MS: number = 10000 // Log at most every 10 seconds
    private lastWsNotReadyLogTime: number = 0

    // Debug: Save streamed audio to file
    private debugAudioStream: fs.WriteStream | null = null
    private debugAudioBytesWritten: number = 0
    private readonly debugAudioEnabled: boolean = process.env.DEBUG_AUDIO === 'true'

    // ========== MEMORY OPTIMIZATION: Reusable buffers ==========
    // Pre-allocated buffers to reduce GC pressure during audio processing
    private reusableNormalizedBuffer: Float32Array | null = null
    private reusableResampledBuffer: Float32Array | null = null
    private reusableInt16Buffer: Int16Array | null = null

    // Memory monitoring
    private memoryCheckIntervalId: NodeJS.Timeout | null = null
    private lastMemoryWarningTime: number = 0
    private readonly MEMORY_WARNING_COOLDOWN_MS: number = 60000 // Don't spam warnings
    private droppedChunksCount: number = 0
    private lastDroppedChunksLogTime: number = 0

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
        if (this.debugAudioEnabled) {
            console.log('🐛 Debug audio file recording enabled (DEBUG_AUDIO=true)')
        }

        this.start()

        Streaming.instance = this
    }

    // ========== MEMORY MONITORING METHODS ==========

    /**
     * Start periodic memory monitoring
     */
    private startMemoryMonitoring(): void {
        if (this.memoryCheckIntervalId) {
            return // Already running
        }

        console.log('📊 [Memory] Starting memory monitoring (check every 30s)')
        this.memoryCheckIntervalId = setInterval(() => {
            this.checkMemoryUsage()
        }, MEMORY_CHECK_INTERVAL_MS)
    }

    /**
     * Stop memory monitoring
     */
    private stopMemoryMonitoring(): void {
        if (this.memoryCheckIntervalId) {
            clearInterval(this.memoryCheckIntervalId)
            this.memoryCheckIntervalId = null
            console.log('📊 [Memory] Stopped memory monitoring')
        }
    }

    /**
     * Check current memory usage and log warnings if needed
     */
    private checkMemoryUsage(): void {
        const memUsage = this.getMemoryUsage()
        const now = Date.now()

        // Log memory stats
        console.log(
            `📊 [Memory] RSS: ${memUsage.rss.toFixed(1)}MB, Heap: ${memUsage.heapUsed.toFixed(1)}/${memUsage.heapTotal.toFixed(1)}MB, ` +
            `External: ${memUsage.external.toFixed(1)}MB, ConnectionBuffer: ${this.connectionBuffer.length} chunks`
        )

        // Check thresholds (with cooldown to avoid spam)
        if (now - this.lastMemoryWarningTime >= this.MEMORY_WARNING_COOLDOWN_MS) {
            if (memUsage.rss >= MEMORY_CRITICAL_THRESHOLD_MB) {
                console.error(
                    `🚨 [Memory] CRITICAL: RSS ${memUsage.rss.toFixed(1)}MB exceeds ${MEMORY_CRITICAL_THRESHOLD_MB}MB threshold! ` +
                    `Consider reducing buffer sizes or investigating leaks.`
                )
                this.lastMemoryWarningTime = now
            } else if (memUsage.rss >= MEMORY_WARNING_THRESHOLD_MB) {
                console.warn(
                    `⚠️ [Memory] WARNING: RSS ${memUsage.rss.toFixed(1)}MB exceeds ${MEMORY_WARNING_THRESHOLD_MB}MB threshold`
                )
                this.lastMemoryWarningTime = now
            }
        }

        // Log dropped chunks count periodically
        if (this.droppedChunksCount > 0 && now - this.lastDroppedChunksLogTime >= 30000) {
            console.warn(`📊 [Memory] Dropped ${this.droppedChunksCount} chunks due to buffer overflow in last 30s`)
            this.droppedChunksCount = 0
            this.lastDroppedChunksLogTime = now
        }
    }

    /**
     * Get current memory usage in MB
     */
    private getMemoryUsage(): { rss: number; heapUsed: number; heapTotal: number; external: number } {
        const mem = process.memoryUsage()
        return {
            rss: mem.rss / 1024 / 1024,
            heapUsed: mem.heapUsed / 1024 / 1024,
            heapTotal: mem.heapTotal / 1024 / 1024,
            external: mem.external / 1024 / 1024
        }
    }

    // ========== REUSABLE BUFFER METHODS ==========

    /**
     * Get or create reusable normalized buffer
     */
    private getNormalizedBuffer(size: number): Float32Array {
        if (!this.reusableNormalizedBuffer || this.reusableNormalizedBuffer.length < size) {
            this.reusableNormalizedBuffer = new Float32Array(size)
        }
        return this.reusableNormalizedBuffer.subarray(0, size)
    }

    /**
     * Get or create reusable resampled buffer
     */
    private getResampledBuffer(size: number): Float32Array {
        if (!this.reusableResampledBuffer || this.reusableResampledBuffer.length < size) {
            this.reusableResampledBuffer = new Float32Array(size)
        }
        return this.reusableResampledBuffer.subarray(0, size)
    }

    /**
     * Get or create reusable Int16 buffer
     */
    private getInt16Buffer(size: number): Int16Array {
        if (!this.reusableInt16Buffer || this.reusableInt16Buffer.length < size) {
            this.reusableInt16Buffer = new Int16Array(size)
        }
        return this.reusableInt16Buffer.subarray(0, size)
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

        // Start memory monitoring
        this.startMemoryMonitoring()

        console.log('✅ Streaming service ready for direct audio processing')
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
            // ========== MEMORY OPTIMIZATION: FIFO buffer with size limit ==========
            const now = Date.now()

            // Initialize buffer start time on first chunk
            if (this.connectionBuffer.length === 0) {
                this.connectionBufferStartTime = now
            }

            // Check if buffer is too old (> 30 seconds) - clear it to prevent stale audio
            const bufferAge = now - this.connectionBufferStartTime
            if (bufferAge > MAX_CONNECTION_BUFFER_DURATION_MS && this.connectionBuffer.length > 0) {
                console.warn(`[Streaming] ⚠️ Connection buffer too old (${(bufferAge / 1000).toFixed(1)}s), clearing ${this.connectionBuffer.length} chunks`)
                this.connectionBuffer = []
                this.connectionBufferStartTime = now
            }

            // FIFO: If buffer is full, remove oldest chunks to make room
            if (this.connectionBuffer.length >= MAX_CONNECTION_BUFFER_SIZE) {
                const chunksToRemove = Math.max(1, Math.floor(MAX_CONNECTION_BUFFER_SIZE * 0.1)) // Remove 10% of buffer
                this.connectionBuffer.splice(0, chunksToRemove)
                this.droppedChunksCount += chunksToRemove
            }

            // Store the audio chunk for later (create a copy to avoid reference issues)
            const float32Data = new Float32Array(audioChunk.audioData)
            this.connectionBuffer.push(float32Data)

            // Throttle warning logs to avoid spam
            if (now - this.lastWsNotReadyLogTime >= this.WS_NOT_READY_LOG_INTERVAL_MS) {
                console.warn(`[Streaming] ⚠️ WebSocket not ready, buffering audio chunks (state: ${this.output_ws?.readyState}, buffered: ${this.connectionBuffer.length})`)
                this.lastWsNotReadyLogTime = now
            }

            // Trigger reconnection if not already reconnecting
            this.scheduleReconnect()
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
            console.error('[Streaming] Failed to process mixed audio chunk:', formatError(error))
        }
    }

    /**
     * Process and send a single audio chunk immediately
     */
    private processAndSendAudioChunk(audioData: Float32Array): void {
        // ========== MEMORY OPTIMIZATION: Use reusable buffers ==========
        // Simple clipping protection - use reusable buffer
        const normalized = this.getNormalizedBuffer(audioData.length)
        for (let i = 0; i < audioData.length; i++) {
            normalized[i] = Math.max(-1, Math.min(1, audioData[i]))
        }

        // Resample if needed (e.g. 48kHz -> 16kHz)
        const sourceRate = this.sourceSampleRate
        const targetRate = this.sample_rate
        let finalBuffer = normalized
        let finalLength = audioData.length

        if (sourceRate !== targetRate) {
            const ratio = sourceRate / targetRate
            const newLength = Math.round(normalized.length / ratio)
            // Use reusable resampled buffer
            const resampled = this.getResampledBuffer(newLength)

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
            finalLength = newLength
        }

        // Convert to Int16 for WebSocket transmission - use reusable buffer
        const s16Array = this.getInt16Buffer(finalLength)
        for (let i = 0; i < finalLength; i++) {
            s16Array[i] = Math.round(
                Math.max(-32768, Math.min(32767, finalBuffer[i] * 32768)),
            )
        }

        // Send to WebSocket
        // Note: We need to create a copy for sending because s16Array is a subarray of reusable buffer
        if (this.output_ws && this.output_ws.readyState === WebSocket.OPEN) {
            // Create a properly sized buffer for sending (subarray.buffer would send the entire underlying buffer)
            const sendBuffer = new Int16Array(s16Array).buffer
            this.output_ws.send(sendBuffer)
            this.browserAudioChunksSent++

            // Write to debug file (pass the subarray, writeDebugAudioChunk will handle it)
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

                // Reset reconnection state on successful connection
                this.isReconnecting = false
                this.reconnectAttempts = 0

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
                // Schedule reconnection on error
                this.scheduleReconnect()
            })

            this.output_ws.on('close', () => {
                console.log('External output WebSocket closed')
                // Schedule reconnection on close (if still initialized)
                if (this.isInitialized) {
                    this.scheduleReconnect()
                }
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

    /**
     * Schedule WebSocket reconnection with exponential backoff
     * Max delay is 1 minute between reconnection attempts
     */
    private scheduleReconnect(): void {
        // Don't reconnect if not initialized or no output URL configured
        if (!this.isInitialized || !this.outputUrl) {
            return
        }

        // Don't schedule if already reconnecting
        if (this.isReconnecting) {
            return
        }

        // Don't reconnect if WebSocket is already open or connecting
        if (this.output_ws &&
            (this.output_ws.readyState === WebSocket.OPEN ||
             this.output_ws.readyState === WebSocket.CONNECTING)) {
            return
        }

        this.isReconnecting = true
        this.reconnectAttempts++

        // Calculate delay with exponential backoff: 1s, 2s, 4s, 8s, ... up to 60s
        const delay = Math.min(
            this.INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
            this.MAX_RECONNECT_DELAY_MS
        )

        console.log(`🔄 Scheduling WebSocket reconnection attempt ${this.reconnectAttempts} in ${(delay / 1000).toFixed(1)}s`)

        // Clear any existing timeout
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId)
        }

        this.reconnectTimeoutId = setTimeout(() => {
            this.reconnectTimeoutId = null
            this.lastReconnectAttemptTime = Date.now()

            // Check again if we should reconnect
            if (!this.isInitialized || !this.outputUrl) {
                this.isReconnecting = false
                return
            }

            console.log(`🔌 Attempting WebSocket reconnection (attempt ${this.reconnectAttempts})...`)
            this.isReconnecting = false // Reset before attempting so setupExternalOutputWS can set it again if needed
            this.setupExternalOutputWS()
        }, delay)
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
    public async stop(): Promise<void> {
        if (!this.isInitialized) {
            console.warn('Cannot stop: streaming service not started')
            return
        }

        console.log('🛑 Stopping simplified streaming service...')

        // Stop memory monitoring
        this.stopMemoryMonitoring()

        // Finalize debug audio file (wait for WAV header to be written)
        await this.finalizeDebugAudioFile()

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
        // Cancel any pending reconnection
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId)
            this.reconnectTimeoutId = null
        }
        this.isReconnecting = false
        this.reconnectAttempts = 0

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

    private processPausedChunks(): void {
        if (this.pausedChunks.length === 0) {
            return
        }

        for (const message of this.pausedChunks) {
            if (message instanceof Buffer) {
                const uint8Array = new Uint8Array(message)
                const f32Array = new Float32Array(uint8Array.buffer)
                
                // Note: Sound level analysis removed (now in SoundLevelMonitor)

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

                    // Note: Sound level analysis removed (now in SoundLevelMonitor)
                    // External audio injection still works for bidirectional streaming
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
            console.error('Failed to initialize debug audio file:', formatError(error))
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
            console.error('Failed to write debug audio chunk:', formatError(error))
        }
    }

    /**
     * Finalize debug audio file (update WAV header with correct size)
     */
    private async finalizeDebugAudioFile(): Promise<void> {
        if (!this.debugAudioStream) return

        const debugPath = PathManager.getInstance().getDebugStreamedAudioPath()
        const bytesWritten = this.debugAudioBytesWritten
        const sampleRate = this.sample_rate
        const stream = this.debugAudioStream

        // Clear instance state immediately to prevent double-finalization
        this.debugAudioStream = null
        this.debugAudioBytesWritten = 0

        await new Promise<void>((resolve, reject) => {
            stream.end(async () => {
                let fd: fsPromises.FileHandle | null = null
                try {
                    // Update WAV header with correct size using async file operations
                    fd = await fsPromises.open(debugPath, 'r+')
                    const header = this.createWavHeader(bytesWritten, sampleRate, 1, 16)
                    await fd.write(new Uint8Array(header), 0, 44, 0)

                    console.log(`🎤 Debug: Streamed audio saved to ${debugPath} (${(bytesWritten / 1024).toFixed(1)} KB)`)
                    resolve()
                } catch (error) {
                    console.error('Failed to update WAV header:', formatError(error))
                    reject(error)
                } finally {
                    // Always close the file descriptor
                    if (fd) {
                        try {
                            await fd.close()
                        } catch (closeError) {
                            console.error('Failed to close debug audio file:', formatError(closeError))
                        }
                    }
                }
            })
        })
    }

}
