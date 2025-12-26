import { WebSocket } from 'ws'
import {
    VoiceRouter,
    GladiaAdapter,
    DeepgramAdapter,
    AssemblyAIAdapter,
    type StreamingSession,
    type TranscriptionProvider,
} from 'voice-router-dev'
import type { StreamingTranscriptionConfig } from './types'
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
 * StreamingTranscription class
 * Handles real-time audio transcription using VoiceRouter SDK
 * and forwards transcripts to user's WebSocket
 */
export class StreamingTranscription {
    private config: StreamingTranscriptionConfig
    private botId: string
    private router: VoiceRouter | null = null
    private session: StreamingSession | null = null
    private userWebSocket: WebSocket | null = null
    private isInitialized = false
    private reconnectAttempts = 0
    private readonly MAX_RECONNECT_ATTEMPTS = 3
    private audioBuffer: Buffer[] = []
    private readonly AUDIO_BUFFER_SIZE = 4

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
            this.initializeVoiceRouter()
            await this.connectToUserWebSocket()
            await this.startTranscriptionStream()
            this.isInitialized = true
            console.log('✅ [StreamingTranscription] Ready')
        } catch (error) {
            console.error('[StreamingTranscription] Failed to start:', formatError(error))
            this.sendErrorToUser('INIT_FAILED', 'Failed to initialize streaming transcription')
            throw error
        }
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
                        reject(new Error('WebSocket connection timeout'))
                    }
                }, 10000)
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
            await new Promise((resolve) => setTimeout(resolve, 1000 * this.reconnectAttempts))
            try {
                await this.connectToUserWebSocket()
                this.reconnectAttempts = 0
            } catch (error) {
                console.error('[StreamingTranscription] Reconnection failed:', formatError(error))
            }
        }
    }

    private async startTranscriptionStream(): Promise<void> {
        if (!this.router) {
            throw new Error('VoiceRouter not initialized')
        }

        const options = this.config.options
        const encoding = this.config.encoding || 'linear16'
        const sampleRate = parseInt(this.config.sample_rate || '16000', 10)

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
     */
    public processAudioChunk(audioData: Int16Array): void {
        if (!this.isInitialized || !this.session) return

        this.audioBuffer.push(Buffer.from(audioData.buffer))

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
        if (this.userWebSocket?.readyState === WebSocket.OPEN) {
            try {
                this.userWebSocket.send(JSON.stringify(event))
            } catch (error) {
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
        if (!this.isInitialized) return

        console.log('🛑 [StreamingTranscription] Stopping...')

        this.flushAudioBuffer()

        if (this.session) {
            try {
                await this.session.close()
            } catch (error) {
                console.error('[StreamingTranscription] Error closing session:', formatError(error))
            }
            this.session = null
        }

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

        console.log('✅ [StreamingTranscription] Stopped')
    }

    public isActive(): boolean {
        return this.isInitialized && this.session !== null
    }
}
