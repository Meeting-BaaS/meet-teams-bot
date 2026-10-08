import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import { Readable } from 'stream'
import { RawData, WebSocket } from 'ws'

import { SoundContext } from './media_context'
import { SpeakerData } from './types'
import { PathManager } from './utils/PathManager'
import { formatError } from './utils/Logger'

const DEFAULT_SAMPLE_RATE: number = 24_000

interface InjectionSource {
    stream: Readable
    setFlowing: (flowing: boolean) => void
    discard: () => void
    dispose: () => void
}

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
    private socketListeners = new Map<
        WebSocket,
        Array<[string, (...args: any[]) => void]>
    >()
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
    private connectionBuffer: Float32Array[] = []
    private readonly MAX_CONNECTION_BUFFER_SIZE: number = 100 // ~4 seconds at 24kHz
    private wsConnectionStartTime: number = 0

    // WebSocket reconnection with exponential backoff
    private isReconnecting: boolean = false
    private reconnectAttempts: number = 0
    private lastReconnectAttemptTime: number = 0
    private reconnectTimeoutId: NodeJS.Timeout | null = null
    private readonly INITIAL_RECONNECT_DELAY_MS: number = 1000 // 1 second
    private readonly MAX_RECONNECT_DELAY_MS: number = 60000 // 1 minute
    private lastWsNotReadyLogTime: number = 0
    private readonly WS_NOT_READY_LOG_INTERVAL_MS: number = 10000 // Log at most every 10 seconds

    private isInputReconnecting: boolean = false
    private inputReconnectAttempts: number = 0
    private inputReconnectTimeoutId: NodeJS.Timeout | null = null

    // Pace raw PCM into FFmpeg; backpressure at the watermark, never truncate speech.
    private static readonly INJECTION_FRAME_MS = 20
    private static readonly INJECTION_START_BUFFER_MS = 80
    private static readonly INJECTION_START_TIMEOUT_MS = 40
    private static readonly INJECTION_HIGH_WATER_MS = 5000
    private static readonly INJECTION_MAX_CATCH_UP_FRAMES = 5
    private injectionPlayer: {
        addInput: (socket: WebSocket) => void
        finish: () => void
        clearQueue: () => void
    } | null = null

    // Debug: Save streamed audio to file
    private debugAudioStream: fs.WriteStream | null = null
    private debugAudioBytesWritten: number = 0
    private readonly debugAudioEnabled: boolean =
        process.env.DEBUG_AUDIO === 'true'

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
            console.log(
                '🐛 Debug audio file recording enabled (DEBUG_AUDIO=true)',
            )
        }

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

        // Setup failures must be able to schedule a reconnect immediately.
        this.isInitialized = true
        this.isPaused = false

        // Setup external output WebSocket if configured
        if (this.outputUrl) {
            this.setupExternalOutputWS()
        }

        // Setup external input WebSocket if configured
        if (this.inputUrl && this.outputUrl !== this.inputUrl) {
            this.setupExternalInputWS()
        }

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
            console.warn(
                '[Streaming] ⚠️ Received audio chunk but streaming not initialized',
            )
            return
        }

        if (!this.output_ws || this.output_ws.readyState !== WebSocket.OPEN) {
            // Throttle warning logs to avoid spam
            const now = Date.now()
            if (
                now - this.lastWsNotReadyLogTime >=
                this.WS_NOT_READY_LOG_INTERVAL_MS
            ) {
                console.warn(
                    '[Streaming] ⚠️ WebSocket not ready, discarding audio chunks (state:',
                    this.output_ws?.readyState,
                    ')',
                )
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
                console.log(
                    `🎵 [Streaming] First audio chunk received from browser: ${audioChunk.numberOfFrames} frames @ ${audioChunk.sampleRate} Hz`,
                )
            }

            // Update source sample rate
            if (audioChunk.sampleRate && audioChunk.sampleRate > 0) {
                if (this.sourceSampleRate !== audioChunk.sampleRate) {
                    console.log(
                        `🎵 [Streaming] Web Audio mixer sample rate: ${audioChunk.sampleRate} Hz`,
                    )
                    this.sourceSampleRate = audioChunk.sampleRate
                }
            }

            // Send directly - no buffering, no manual mixing!
            this.processAndSendAudioChunk(float32Data)

            // Log stats every 5 seconds
            const now = Date.now()
            if (now - this.lastBrowserStatsLogTime > 5000) {
                console.log(
                    `📊 [Streaming] Sent ${this.browserAudioChunksSent} audio chunks to WebSocket`,
                )
                this.lastBrowserStatsLogTime = now
            }
        } catch (error) {
            console.error(
                '[Streaming] Failed to process mixed audio chunk:',
                formatError(error),
            )
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
            if (
                this.output_ws &&
                this.output_ws.readyState === WebSocket.OPEN
            ) {
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
            console.log(
                `🔌 Connecting to external output WebSocket: ${this.outputUrl}`,
            )
            const output_ws = new WebSocket(this.outputUrl!)
            this.output_ws = output_ws
            this.wsConnectionStartTime = Date.now()

            this.listenToSocket(output_ws, 'open', () => {
                const connectionTime = Date.now() - this.wsConnectionStartTime
                console.log(
                    `✅ External output WebSocket connected in ${connectionTime}ms`,
                )

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
                    console.log(
                        `🤝 Sending handshake to ${this.outputUrl}: ${JSON.stringify(handshake)}`,
                    )
                    this.output_ws.send(JSON.stringify(handshake))

                    // Flush any buffered audio chunks
                    this.flushConnectionBuffer()

                    // Initialize debug audio file if enabled
                    if (this.debugAudioEnabled) {
                        this.initDebugAudioFile()
                    }
                }
            })

            this.listenToSocket(output_ws, 'error', (err: Error) => {
                console.error(
                    'External output WebSocket error:',
                    formatError(err),
                )
                // Schedule reconnection on error
                this.scheduleReconnect()
            })

            this.listenToSocket(output_ws, 'close', () => {
                console.log('External output WebSocket closed')
                // Schedule reconnection on close (if still initialized)
                if (this.isInitialized) {
                    this.scheduleReconnect()
                }
                this.removeSocketListeners(output_ws)
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
            const input_ws = new WebSocket(this.inputUrl!)
            this.input_ws = input_ws

            this.listenToSocket(input_ws, 'open', () => {
                if (this.input_ws !== input_ws || !this.isInitialized) return
                console.log('✅ External input WebSocket connected')
                this.isInputReconnecting = false
                this.inputReconnectAttempts = 0
                if (this.inputReconnectTimeoutId) {
                    clearTimeout(this.inputReconnectTimeoutId)
                    this.inputReconnectTimeoutId = null
                }
            })

            this.listenToSocket(input_ws, 'error', (err: Error) => {
                console.error(
                    'External input WebSocket error:',
                    formatError(err),
                )
                if (this.input_ws === input_ws) this.scheduleInputReconnect()
            })

            this.listenToSocket(input_ws, 'close', () => {
                if (this.input_ws === input_ws) this.scheduleInputReconnect()
                this.removeSocketListeners(input_ws)
            })

            this.play_incoming_audio_chunks(input_ws)
        } catch (error) {
            console.error(
                'Failed to setup external input WebSocket:',
                formatError(error),
            )
            this.scheduleInputReconnect()
        }
    }

    private scheduleInputReconnect(): void {
        if (
            !this.isInitialized ||
            !this.inputUrl ||
            this.inputUrl === this.outputUrl
        )
            return
        if (this.isInputReconnecting) return
        if (
            this.input_ws &&
            (this.input_ws.readyState === WebSocket.OPEN ||
                this.input_ws.readyState === WebSocket.CONNECTING)
        )
            return

        this.isInputReconnecting = true
        this.inputReconnectAttempts++
        const delay = Math.min(
            this.INITIAL_RECONNECT_DELAY_MS *
                Math.pow(2, this.inputReconnectAttempts - 1),
            this.MAX_RECONNECT_DELAY_MS,
        )
        console.log(
            `[Streaming] Input WebSocket reconnect attempt ${this.inputReconnectAttempts} in ${delay}ms`,
        )
        this.inputReconnectTimeoutId = setTimeout(() => {
            this.inputReconnectTimeoutId = null
            this.isInputReconnecting = false
            if (!this.isInitialized || !this.inputUrl) return
            this.setupExternalInputWS()
        }, delay)
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
        if (
            this.output_ws &&
            (this.output_ws.readyState === WebSocket.OPEN ||
                this.output_ws.readyState === WebSocket.CONNECTING)
        ) {
            return
        }

        this.isReconnecting = true
        this.reconnectAttempts++

        // Calculate delay with exponential backoff: 1s, 2s, 4s, 8s, ... up to 60s
        const delay = Math.min(
            this.INITIAL_RECONNECT_DELAY_MS *
                Math.pow(2, this.reconnectAttempts - 1),
            this.MAX_RECONNECT_DELAY_MS,
        )

        console.log(
            `🔄 Scheduling WebSocket reconnection attempt ${this.reconnectAttempts} in ${(delay / 1000).toFixed(1)}s`,
        )

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

            console.log(
                `🔌 Attempting WebSocket reconnection (attempt ${this.reconnectAttempts})...`,
            )
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
        // Drop any partial inbound sample: paused messages are discarded, so a
        // leftover byte would misalign the first message after resume.
        this.injectionPlayer?.clearQueue()
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
        this.injectionPlayer?.clearQueue()
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

        // Disable reconnects and playout before asynchronous finalization.
        this.isInitialized = false
        this.closeExternalWebSockets()

        // Reset state
        this.isPaused = false
        this.pausedChunks = []
        Streaming.instance = null

        // Finalize debug audio file (wait for WAV header to be written)
        await this.finalizeDebugAudioFile()

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

        if (this.inputReconnectTimeoutId) {
            clearTimeout(this.inputReconnectTimeoutId)
            this.inputReconnectTimeoutId = null
        }
        this.isInputReconnecting = false
        this.inputReconnectAttempts = 0
        this.injectionPlayer?.finish()
        this.injectionPlayer = null

        // Close external output WebSocket
        try {
            if (this.output_ws) {
                this.disposeExternalSocket(this.output_ws)
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
                this.disposeExternalSocket(this.input_ws)
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

    private listenToSocket(
        socket: WebSocket,
        event: string,
        listener: (...args: any[]) => void,
    ): void {
        socket.on(event, listener)
        const listeners = this.socketListeners.get(socket) ?? []
        listeners.push([event, listener])
        this.socketListeners.set(socket, listeners)
    }

    private removeSocketListeners(socket: WebSocket): void {
        for (const [event, listener] of this.socketListeners.get(socket) ??
            []) {
            socket.removeListener(event, listener)
        }
        this.socketListeners.delete(socket)
    }

    private disposeExternalSocket(socket: WebSocket): void {
        this.removeSocketListeners(socket)
        if (socket.readyState === WebSocket.CLOSED) return
        // terminate() also releases a paused connection without waiting for a
        // close handshake. A CONNECTING socket can emit an error during abort.
        const onError = () => {}
        socket.on('error', onError)
        socket.once('close', () => socket.removeListener('error', onError))
        socket.terminate()
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

    // Pace inbound PCM in fixed-size frames, filling gaps with silence.
    private play_incoming_audio_chunks = (input_ws: WebSocket) => {
        if (this.injectionPlayer) {
            this.injectionPlayer.addInput(input_ws)
            return
        }
        new SoundContext(this.sample_rate)
        const stdin = SoundContext.instance.play_stdin()
        const frameSamples = Math.max(
            1,
            Math.round(
                (this.sample_rate * Streaming.INJECTION_FRAME_MS) / 1000,
            ),
        )
        const frameBytes = frameSamples * 4
        const startBufferBytes =
            Math.ceil(
                (this.sample_rate * Streaming.INJECTION_START_BUFFER_MS) / 1000,
            ) * 4
        const highWaterBytes =
            Math.max(
                1,
                Math.floor(
                    (this.sample_rate * Streaming.INJECTION_HIGH_WATER_MS) /
                        1000,
                ),
            ) * 4
        const lowWaterBytes = highWaterBytes / 2
        const sources: InjectionSource[] = []
        const queue: Buffer[] = []
        let queueOffset = 0
        let queuedBytes = 0
        let maxQueuedBytesSeen = 0
        let inputSamples = 0
        let outputSamples = 0
        let silenceSamples = 0
        let backpressureCount = 0
        let lastStatsLogTime = Date.now()
        let startTimeout: NodeJS.Timeout | null = null
        let pumpInterval: NodeJS.Timeout | null = null
        let pumpStartedAt = 0
        let framesWritten = 0
        let pumpStarted = false
        let waitingDrain = false
        let finished = false
        let inputBackpressured = false
        let discarding = false

        const updateInputFlow = () => {
            if (finished) return
            if (waitingDrain || queuedBytes >= highWaterBytes)
                inputBackpressured = true
            else if (queuedBytes <= lowWaterBytes) inputBackpressured = false
            for (const [index, source] of sources.entries()) {
                source.setFlowing(
                    index === 0 && (this.isPaused || !inputBackpressured),
                )
            }
        }

        const clearQueue = () => {
            queue.length = 0
            queueOffset = 0
            queuedBytes = 0
            discarding = true
            for (const source of sources) source.discard()
            discarding = false
            updateInputFlow()
        }
        const onDrain = () => {
            waitingDrain = false
            updateInputFlow()
        }
        const finish = () => {
            if (finished) return
            finished = true
            if (startTimeout) clearTimeout(startTimeout)
            if (pumpInterval) clearInterval(pumpInterval)
            clearQueue()
            for (const source of sources) source.dispose()
            sources.length = 0
            stdin.removeListener('drain', onDrain)
            stdin.removeListener('error', finish)
            stdin.removeListener('close', finish)
            if (this.injectionPlayer === player) this.injectionPlayer = null
            if (!stdin.destroyed && !stdin.writableEnded) stdin.end()
        }

        const logStats = () => {
            const now = Date.now()
            if (now - lastStatsLogTime < 5000) return
            const milliseconds = (samples: number) =>
                Math.round((samples * 1000) / this.sample_rate)
            console.info(
                `[Streaming] Injection: in=${milliseconds(inputSamples)}ms out=${milliseconds(outputSamples)}ms silence=${milliseconds(silenceSamples)}ms queue=${milliseconds(queuedBytes / 4)}ms maxQueue=${milliseconds(maxQueuedBytesSeen / 4)}ms backpressure=${backpressureCount}`,
            )
            inputSamples =
                outputSamples =
                silenceSamples =
                backpressureCount =
                    0
            maxQueuedBytesSeen = queuedBytes
            lastStatsLogTime = now
        }

        const writeFrame = () => {
            if (finished || waitingDrain) return
            if (stdin.destroyed || stdin.writableEnded) {
                finish()
                return
            }
            if (this.isPaused) clearQueue()

            const frame = Buffer.alloc(frameBytes)
            let copiedBytes = 0
            if (!this.isPaused) {
                while (copiedBytes < frameBytes && queue.length > 0) {
                    const first = queue[0]
                    const copyBytes = Math.min(
                        frameBytes - copiedBytes,
                        first.length - queueOffset,
                    )
                    first.copy(
                        frame,
                        copiedBytes,
                        queueOffset,
                        queueOffset + copyBytes,
                    )
                    copiedBytes += copyBytes
                    queueOffset += copyBytes
                    queuedBytes -= copyBytes
                    if (queueOffset === first.length) {
                        queue.shift()
                        queueOffset = 0
                    }
                }
            }
            outputSamples += frameSamples
            silenceSamples += frameSamples - copiedBytes / 4
            if (!stdin.write(frame)) {
                waitingDrain = true
                backpressureCount++
                stdin.once('drain', onDrain)
            }
            updateInputFlow()
            logStats()
        }

        const startPump = () => {
            if (pumpStarted || finished) return
            pumpStarted = true
            if (startTimeout) {
                clearTimeout(startTimeout)
                startTimeout = null
            }
            pumpStartedAt = performance.now()
            framesWritten = 0
            const tick = () => {
                if (finished) return
                const elapsedMs = performance.now() - pumpStartedAt
                const dueFrames =
                    Math.floor(elapsedMs / Streaming.INJECTION_FRAME_MS) + 1
                let catchUpFrames = 0
                while (
                    !finished &&
                    !waitingDrain &&
                    framesWritten < dueFrames &&
                    catchUpFrames < Streaming.INJECTION_MAX_CATCH_UP_FRAMES
                ) {
                    writeFrame()
                    framesWritten++
                    catchUpFrames++
                }
                // Bound bursts after event-loop stalls or a slow stdin drain.
                if (
                    dueFrames - framesWritten >
                    Streaming.INJECTION_MAX_CATCH_UP_FRAMES
                ) {
                    framesWritten = dueFrames
                }
            }
            tick()
            if (!finished)
                pumpInterval = setInterval(
                    tick,
                    Streaming.INJECTION_FRAME_MS / 2,
                )
        }

        const enqueue = (chunk: Buffer) => {
            if (finished || discarding || this.isPaused || chunk.length === 0)
                return
            inputSamples += chunk.length / 4
            // Keep the entire delivered message, even if it crosses the watermark.
            // Backpressure stops subsequent reads instead of truncating speech.
            queue.push(chunk)
            queuedBytes += chunk.length
            maxQueuedBytesSeen = Math.max(maxQueuedBytesSeen, queuedBytes)
            updateInputFlow()
            if (!pumpStarted) {
                if (queuedBytes >= startBufferBytes) startPump()
                else if (!startTimeout)
                    startTimeout = setTimeout(
                        startPump,
                        Streaming.INJECTION_START_TIMEOUT_MS,
                    )
            }
            logStats()
        }

        const addInput = (socket: WebSocket) => {
            if (finished) return
            const source = this.createAudioStreamFromWebSocket(socket)
            sources.push(source)
            source.stream.on('data', enqueue)
            source.stream.once('end', () => {
                const index = sources.indexOf(source)
                if (index !== -1) sources.splice(index, 1)
                source.dispose()
                // All old samples are now in the FIFO before the next input reads.
                updateInputFlow()
                if (!pumpStarted && queuedBytes > 0) startPump()
            })
            updateInputFlow()
        }
        const player = { addInput, finish, clearQueue }
        this.injectionPlayer = player
        stdin.on('error', finish)
        stdin.on('close', finish)
        addInput(input_ws)
    }

    private createAudioStreamFromWebSocket = (
        input_ws: WebSocket,
    ): InjectionSource => {
        // Partial samples belong to a connection, never to its replacement.
        let remainder = Buffer.alloc(0)
        let flowing = false
        let wantsData = true
        let disposed = false
        const syncSocket = () => {
            if (
                disposed ||
                !this.isInitialized ||
                input_ws.readyState === WebSocket.CLOSED
            )
                return
            // Paused recording intentionally discards messages rather than saving
            // them in TCP buffers to replay after resume.
            if (this.isPaused || (flowing && wantsData)) input_ws.resume()
            else input_ws.pause()
        }
        const stream = new Readable({
            read() {
                wantsData = true
                syncSocket()
            },
        })
        stream.pause()

        const onMessage = (message: RawData) => {
            if (disposed || this.isPaused) {
                remainder = Buffer.alloc(0)
                return
            }

            if (message instanceof Buffer) {
                try {
                    // Prepend any leftover byte from the previous message, then decode
                    // only whole Int16 samples (2-byte aligned). Anything trailing is an
                    // incomplete sample — hold it for the next message instead of
                    // dropping it or misaligning the stream.
                    const buf =
                        remainder.length > 0
                            ? Buffer.concat([remainder, message])
                            : message
                    const alignedLen = buf.length - (buf.length % 2)
                    if (alignedLen === 0) {
                        remainder = Buffer.from(buf)
                        return
                    }
                    remainder =
                        alignedLen < buf.length
                            ? Buffer.from(buf.subarray(alignedLen))
                            : Buffer.alloc(0)

                    const sampleCount = alignedLen / 2
                    const f32Array = new Float32Array(sampleCount)
                    for (let i = 0; i < sampleCount; i++) {
                        // Read Int16 LE explicitly — avoids ArrayBuffer alignment/offset
                        // pitfalls of `new Int16Array(buf.buffer)` on pooled Node buffers.
                        f32Array[i] = buf.readInt16LE(i * 2) / 32768
                    }

                    // Note: Sound level analysis removed (now in SoundLevelMonitor)
                    // External audio injection still works for bidirectional streaming
                    if (!stream.push(Buffer.from(f32Array.buffer))) {
                        wantsData = false
                        syncSocket()
                    }
                } catch (error) {
                    console.error(
                        'Error processing external audio chunk:',
                        formatError(error),
                    )
                }
            }
        }
        const onClose = () => {
            remainder = Buffer.alloc(0)
            stream.push(null)
        }
        input_ws.on('message', onMessage)
        input_ws.once('close', onClose)
        input_ws.on('open', syncSocket)
        syncSocket()

        return {
            stream,
            setFlowing: (enabled) => {
                flowing = enabled
                if (enabled) stream.resume()
                else stream.pause()
                syncSocket()
            },
            discard: () => {
                remainder = Buffer.alloc(0)
                while (stream.read() !== null) {
                    /* Drop intentionally paused audio. */
                }
                syncSocket()
            },
            dispose: () => {
                disposed = true
                input_ws.removeListener('message', onMessage)
                input_ws.removeListener('close', onClose)
                input_ws.removeListener('open', syncSocket)
                stream.removeAllListeners()
                stream.destroy()
            },
        }
    }

    /**
     * Initialize debug audio file for saving streamed audio
     */
    private initDebugAudioFile(): void {
        try {
            const debugPath =
                PathManager.getInstance().getDebugStreamedAudioPath()
            console.log(`🎤 Debug: Saving streamed audio to ${debugPath}`)

            this.debugAudioStream = fs.createWriteStream(debugPath)
            this.debugAudioBytesWritten = 0

            // Write WAV header (will be updated with correct size when closing)
            const header = this.createWavHeader(0, this.sample_rate, 1, 16)
            this.debugAudioStream.write(header)
        } catch (error) {
            console.error(
                'Failed to initialize debug audio file:',
                formatError(error),
            )
            this.debugAudioStream = null
        }
    }

    /**
     * Create WAV header
     */
    private createWavHeader(
        dataSize: number,
        sampleRate: number,
        channels: number,
        bitsPerSample: number,
    ): Buffer {
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
        header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28) // Byte rate
        header.writeUInt16LE((channels * bitsPerSample) / 8, 32) // Block align
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
            console.error(
                'Failed to write debug audio chunk:',
                formatError(error),
            )
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
                    const header = this.createWavHeader(
                        bytesWritten,
                        sampleRate,
                        1,
                        16,
                    )
                    await fd.write(new Uint8Array(header), 0, 44, 0)

                    console.log(
                        `🎤 Debug: Streamed audio saved to ${debugPath} (${(bytesWritten / 1024).toFixed(1)} KB)`,
                    )
                    resolve()
                } catch (error) {
                    console.error(
                        'Failed to update WAV header:',
                        formatError(error),
                    )
                    reject(error)
                } finally {
                    // Always close the file descriptor
                    if (fd) {
                        try {
                            await fd.close()
                        } catch (closeError) {
                            console.error(
                                'Failed to close debug audio file:',
                                formatError(closeError),
                            )
                        }
                    }
                }
            })
        })
    }
}
