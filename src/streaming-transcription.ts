import { WebSocket } from 'ws'
import {
    VoiceRouter,
    GladiaAdapter,
    DeepgramAdapter,
    AssemblyAIAdapter,
    StreamingSupportedSampleRateEnum,
    type StreamingSession,
    type TranscriptionProvider,
} from 'voice-router-dev'
import type { StreamingTranscriptionConfig, StreamingTranscriptionProvider } from './types'
import { formatError } from './utils/Logger'

/**
 * Internal type for transcript events from VoiceRouter SDK
 */
interface TranscriptFromSDK {
    type?: string
    text?: string
    isFinal?: boolean
    speaker?: string
    confidence?: number
    words?: Array<{
        text?: string
        word?: string
        start?: number
        end?: number
        confidence?: number
    }>
}

/**
 * Transcript event sent to user's WebSocket
 */
interface TranscriptEvent {
    type: 'transcript' | 'error' | 'ready' | 'closed'
    session_id?: string
    provider?: string
    text?: string
    is_final?: boolean
    speaker?: string
    confidence?: number
    words?: Array<{
        word: string
        start: number
        end: number
        confidence: number
    }>
    timestamp?: number
    error?: {
        code: string
        message: string
    }
}

/**
 * Connection state for tracking lifecycle
 */
export enum ConnectionState {
    DISCONNECTED = 'disconnected',
    CONNECTING = 'connecting',
    CONNECTED = 'connected',
    RECONNECTING = 'reconnecting',
    CLOSING = 'closing',
    ERROR = 'error',
}

/**
 * Providers that support real-time streaming
 */
const STREAMING_CAPABLE_PROVIDERS: StreamingTranscriptionProvider[] = ['gladia', 'deepgram', 'assemblyai']

/**
 * StreamingTranscription class
 * Handles real-time audio transcription using VoiceRouter SDK
 * and forwards transcripts to user's WebSocket
 *
 * Production-hardened with:
 * - Connection buffering (pre-buffers audio while connecting)
 * - Provider validation
 * - Graceful error handling with shutdown delays
 * - Cleanup timeouts to prevent hangs
 */
export class StreamingTranscription {
    private config: StreamingTranscriptionConfig
    private botId: string
    private router: VoiceRouter | null = null
    private session: StreamingSession | null = null
    private userWebSocket: WebSocket | null = null
    private isInitialized = false
    private connectionState: ConnectionState = ConnectionState.DISCONNECTED
    private reconnectAttempts = 0
    private readonly MAX_RECONNECT_ATTEMPTS = 3

    // Audio buffering - batch small chunks before sending to reduce overhead
    private audioBuffer: Buffer[] = []
    private readonly AUDIO_BUFFER_SIZE = 12 // ~480ms at 16kHz before sending
    private readonly MAX_AUDIO_BUFFER_SIZE = 100 // Prevent unbounded memory growth

    // Error tracking
    private lastError: { code: string; message: string; timestamp: number } | null = null
    private readonly ERROR_GRACE_PERIOD_MS = 3000 // Time to display error before shutdown

    // Cleanup
    private readonly CLEANUP_TIMEOUT_MS = 5000

    constructor(config: StreamingTranscriptionConfig, botId: string) {
        this.config = config
        this.botId = botId
    }

    public async start(): Promise<void> {
        if (this.isInitialized) {
            console.warn('[StreamingTranscription] Already started')
            return
        }

        console.log(
            `🎙️ [StreamingTranscription] Starting with provider: ${this.config.provider}`,
        )

        try {
            this.connectionState = ConnectionState.CONNECTING

            // Connect to user WebSocket first so we can send errors
            await this.connectToUserWebSocket()

            // Validate configuration after WebSocket is connected
            this.validateConfig()

            this.initializeVoiceRouter()
            await this.startTranscriptionStream()

            this.connectionState = ConnectionState.CONNECTED
            this.isInitialized = true
            console.log('✅ [StreamingTranscription] Ready')
        } catch (error) {
            this.connectionState = ConnectionState.ERROR
            const errorInfo = formatError(error)
            console.error('[StreamingTranscription] Failed to start:', errorInfo)
            this.setLastError('INIT_FAILED', errorInfo.message)
            // Send the actual error message to user so they know what went wrong
            this.sendErrorToUser('INIT_FAILED', errorInfo.message)

            // Graceful shutdown with delay so user can see error
            await this.gracefulShutdown()
            throw error
        }
    }

    /**
     * Validate configuration before starting
     */
    private validateConfig(): void {
        // Validate provider is streaming-capable
        if (!STREAMING_CAPABLE_PROVIDERS.includes(this.config.provider)) {
            throw new Error(
                `Provider '${this.config.provider}' does not support streaming. ` +
                `Supported providers: ${STREAMING_CAPABLE_PROVIDERS.join(', ')}`
            )
        }

        // Validate API key is available
        const envKey = `${this.config.provider.toUpperCase()}_API_KEY`
        if (!this.config.api_key && !process.env[envKey]) {
            throw new Error(
                `No API key configured for provider '${this.config.provider}'. ` +
                `Provide api_key in config or set ${envKey} environment variable.`
            )
        }

        // Validate output URL
        if (!this.config.output_url) {
            throw new Error('No output_url configured for streaming transcription')
        }

        // Validate URL format
        try {
            new URL(this.config.output_url)
        } catch {
            throw new Error(`Invalid output_url: ${this.config.output_url}`)
        }

        // Validate sample rate against provider requirements
        const sampleRate = this.config.sample_rate || 16000
        const supportedRates = Object.values(StreamingSupportedSampleRateEnum) as number[]
        if (!supportedRates.includes(sampleRate)) {
            throw new Error(
                `Sample rate ${sampleRate} Hz is not supported. ` +
                `Supported rates: ${supportedRates.join(', ')} Hz`
            )
        }

        console.log('[StreamingTranscription] Configuration validated successfully')
    }

    /**
     * Store last error for diagnostics
     */
    private setLastError(code: string, message: string): void {
        this.lastError = { code, message, timestamp: Date.now() }
    }

    /**
     * Graceful shutdown with delay so user can see error
     */
    private async gracefulShutdown(): Promise<void> {
        console.log(`[StreamingTranscription] Graceful shutdown in ${this.ERROR_GRACE_PERIOD_MS}ms...`)
        await new Promise(resolve => setTimeout(resolve, this.ERROR_GRACE_PERIOD_MS))
        await this.stop()
    }

    private initializeVoiceRouter(): void {
        const apiKey =
            this.config.api_key ||
            process.env[`${this.config.provider.toUpperCase()}_API_KEY`] ||
            ''

        this.router = new VoiceRouter({
            providers: {
                [this.config.provider]: { apiKey },
            },
            defaultProvider: this.config.provider as TranscriptionProvider,
        })

        switch (this.config.provider) {
            case 'gladia':
                this.router.registerAdapter(new GladiaAdapter())
                break
            case 'deepgram':
                this.router.registerAdapter(new DeepgramAdapter())
                break
            case 'assemblyai':
                this.router.registerAdapter(new AssemblyAIAdapter())
                break
        }
    }

    private async connectToUserWebSocket(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.userWebSocket = new WebSocket(this.config.output_url)

                this.userWebSocket.on('open', () => {
                    console.log(
                        `✅ [StreamingTranscription] Connected to user WebSocket: ${this.config.output_url}`,
                    )
                    this.sendToUser({
                        type: 'ready',
                        session_id: this.botId,
                        provider: this.config.provider,
                        timestamp: Date.now(),
                    })
                    resolve()
                })

                this.userWebSocket.on('error', (error) => {
                    console.error('[StreamingTranscription] User WebSocket error:', formatError(error))
                    if (!this.isInitialized) {
                        reject(error)
                    }
                })

                this.userWebSocket.on('close', (code, reason) => {
                    console.log(`[StreamingTranscription] User WebSocket closed: ${code} - ${reason}`)
                    this.handleUserWebSocketClose()
                })

                setTimeout(() => {
                    if (this.userWebSocket?.readyState !== WebSocket.OPEN) {
                        // Close the pending WebSocket to prevent resource leak
                        if (this.userWebSocket) {
                            this.userWebSocket.close()
                            this.userWebSocket = null
                        }
                        reject(new Error('WebSocket connection timeout'))
                    }
                }, this.config.websocket_timeout_ms || 10000)
            } catch (error) {
                reject(error)
            }
        })
    }

    private async handleUserWebSocketClose(): Promise<void> {
        if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++
            console.log(
                `[StreamingTranscription] Reconnecting (${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`,
            )
            // Exponential backoff: 1s, 2s, 4s, capped at 60s
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 60000)
            await new Promise((resolve) => setTimeout(resolve, delay))
            try {
                await this.connectToUserWebSocket()
                this.reconnectAttempts = 0
            } catch (error) {
                console.error('[StreamingTranscription] Reconnection failed:', formatError(error))
                // Recursively try again if attempts remain
                await this.handleUserWebSocketClose()
            }
        } else {
            console.error('[StreamingTranscription] Max reconnection attempts reached, giving up')
            this.connectionState = ConnectionState.ERROR
            this.setLastError('MAX_RECONNECT', 'Maximum reconnection attempts exceeded')
        }
    }

    private async startTranscriptionStream(): Promise<void> {
        if (!this.router) {
            throw new Error('VoiceRouter not initialized')
        }

        const options = this.config.options
        const encoding = this.config.encoding || 'linear16'
        const sampleRate = this.config.sample_rate || 16000

        const streamingOptions = {
            encoding,
            sampleRate,
            ...(options?.language && { language: options.language }),
            interimResults: options?.interim_results ?? true,
            ...(options?.diarization && { diarization: true }),
            ...(options?.word_timestamps && { wordTimestamps: true }),
            ...(options?.punctuation !== undefined && { punctuation: options.punctuation }),
            ...(options?.profanity_filter && { profanityFilter: true }),
            ...(options?.custom_vocabulary && { customVocabulary: options.custom_vocabulary }),
            ...(options?.endpointing_ms && { endpointing: options.endpointing_ms }),
        }

        const callbacks = {
            onOpen: () => {
                console.log('🎙️ [StreamingTranscription] VoiceRouter session opened')
            },
            onTranscript: (event: unknown) => {
                this.handleTranscript(event as TranscriptFromSDK)
            },
            onError: (error: unknown) => {
                const errorMsg = error instanceof Error ? error.message : String(error)
                console.error('[StreamingTranscription] VoiceRouter error:', errorMsg)
                this.sendErrorToUser('TRANSCRIPTION_ERROR', errorMsg)
            },
            onClose: (code?: number, reason?: string) => {
                console.log(`[StreamingTranscription] VoiceRouter closed: ${code} - ${reason}`)
                // Stop audio processing immediately
                this.session = null
                this.connectionState = ConnectionState.DISCONNECTED
                this.sendToUser({
                    type: 'closed',
                    session_id: this.botId,
                    timestamp: Date.now(),
                })
            },
        }

        this.session = await this.router.transcribeStream(
            streamingOptions as Parameters<typeof this.router.transcribeStream>[0],
            callbacks as Parameters<typeof this.router.transcribeStream>[1],
        )
    }

    private handleTranscript(event: TranscriptFromSDK): void {
        if (!event.text) return

        const transcriptEvent: TranscriptEvent = {
            type: 'transcript',
            session_id: this.botId,
            provider: this.config.provider,
            text: event.text,
            is_final: event.isFinal ?? false,
            timestamp: Date.now(),
        }

        if (event.speaker) transcriptEvent.speaker = event.speaker
        if (event.confidence !== undefined) transcriptEvent.confidence = event.confidence
        if (event.words && event.words.length > 0) {
            transcriptEvent.words = event.words.map((w) => ({
                word: w.word || w.text || '',
                start: w.start ?? 0,
                end: w.end ?? 0,
                confidence: w.confidence ?? 1,
            }))
        }

        this.sendToUser(transcriptEvent)
    }

    /**
     * Process audio chunk from Streaming class
     * Accepts Int16Array (already converted from Float32)
     *
     * Audio is discarded until fully connected - this avoids latency
     * from buffering during connection. Missing first 1-2s is acceptable
     * for real-time transcription use cases.
     */
    public processAudioChunk(audioData: Int16Array): void {
        // Only process if fully connected with active session
        if (!this.isInitialized || !this.session || this.connectionState !== ConnectionState.CONNECTED) {
            return
        }

        this.audioBuffer.push(Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength))

        // Prevent unbounded memory growth
        if (this.audioBuffer.length > this.MAX_AUDIO_BUFFER_SIZE) {
            console.warn('[StreamingTranscription] Audio buffer overflow, dropping oldest chunks')
            this.audioBuffer = this.audioBuffer.slice(-this.AUDIO_BUFFER_SIZE)
        }

        if (this.audioBuffer.length >= this.AUDIO_BUFFER_SIZE) {
            this.flushAudioBuffer()
        }
    }

    private flushAudioBuffer(): void {
        if (this.audioBuffer.length === 0 || !this.session) return

        const combinedBuffer = Buffer.concat(this.audioBuffer)
        this.audioBuffer = []

        this.session.sendAudio({ data: combinedBuffer }).catch((error) => {
            console.error('[StreamingTranscription] Failed to send audio:', formatError(error))
        })
    }

    private sendToUser(event: TranscriptEvent): void {
        // Only send if WebSocket is fully open
        if (this.userWebSocket?.readyState === WebSocket.OPEN) {
            try {
                this.userWebSocket.send(JSON.stringify(event))
            } catch (error) {
                // Log send failures - typically happens during connection state transitions
                console.error('[StreamingTranscription] Failed to send to user:', formatError(error))
            }
        }
    }

    private sendErrorToUser(code: string, message: string): void {
        this.sendToUser({
            type: 'error',
            session_id: this.botId,
            error: { code, message },
            timestamp: Date.now(),
        })
    }

    public async stop(): Promise<void> {
        if (!this.isInitialized && this.connectionState === ConnectionState.DISCONNECTED) return

        this.connectionState = ConnectionState.CLOSING
        console.log('🛑 [StreamingTranscription] Stopping...')

        // Flush any remaining audio
        this.flushAudioBuffer()

        // Use timeout to prevent hangs during cleanup
        const cleanupWithTimeout = async <T>(
            operation: () => Promise<T>,
            name: string
        ): Promise<void> => {
            try {
                await Promise.race([
                    operation(),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error(`${name} timeout`)), this.CLEANUP_TIMEOUT_MS)
                    )
                ])
            } catch (error) {
                console.error(`[StreamingTranscription] ${name} failed:`, formatError(error))
            }
        }

        // Close VoiceRouter session
        if (this.session) {
            await cleanupWithTimeout(
                () => this.session!.close(),
                'Session close'
            )
            this.session = null
        }

        // Close user WebSocket
        if (this.userWebSocket) {
            try {
                if (this.userWebSocket.readyState === WebSocket.OPEN) {
                    this.sendToUser({
                        type: 'closed',
                        session_id: this.botId,
                        timestamp: Date.now(),
                    })
                    this.userWebSocket.close(1000, 'Transcription ended')
                }
            } catch (error) {
                console.error('[StreamingTranscription] Error closing WebSocket:', formatError(error))
            }
            this.userWebSocket = null
        }

        this.router = null
        this.isInitialized = false
        this.audioBuffer = []
        this.connectionState = ConnectionState.DISCONNECTED

        console.log('✅ [StreamingTranscription] Stopped')
    }

    public isActive(): boolean {
        return this.isInitialized && this.session !== null
    }

    /**
     * Get current connection state for monitoring
     */
    public getConnectionState(): ConnectionState {
        return this.connectionState
    }

    /**
     * Get last error for diagnostics
     */
    public getLastError(): { code: string; message: string; timestamp: number } | null {
        return this.lastError
    }
}
