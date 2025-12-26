import { WebSocket } from "ws"
import {
  VoiceRouter,
  GladiaAdapter,
  DeepgramAdapter,
  AssemblyAIAdapter,
  type StreamingSession,
  type TranscriptionProvider
} from "voice-router-dev"
import type { StreamingTranscriptionConfig } from "./utils/meeting-params-schema"

/**
 * Internal type for transcript events from VoiceRouter SDK
 * Using a flexible type to handle SDK type variations
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
  type: "transcript" | "error" | "ready" | "closed"
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
  private readonly AUDIO_BUFFER_SIZE = 4 // Buffer 4 chunks before sending

  constructor(config: StreamingTranscriptionConfig, botId: string) {
    this.config = config
    this.botId = botId
  }

  /**
   * Initialize the streaming transcription service
   * Sets up VoiceRouter and connects to user's WebSocket
   */
  public async start(): Promise<void> {
    if (this.isInitialized) {
      console.warn("StreamingTranscription already started")
      return
    }

    console.log(
      `🎙️ Starting streaming transcription with provider: ${this.config.provider}`
    )

    try {
      // Initialize VoiceRouter with the configured provider
      this.initializeVoiceRouter()

      // Connect to user's WebSocket for transcript delivery
      await this.connectToUserWebSocket()

      // Start the transcription stream
      await this.startTranscriptionStream()

      this.isInitialized = true
      console.log("✅ Streaming transcription ready")
    } catch (error) {
      console.error("Failed to start streaming transcription:", error)
      this.sendErrorToUser("INIT_FAILED", "Failed to initialize streaming transcription")
      throw error
    }
  }

  /**
   * Initialize VoiceRouter with the appropriate provider adapter
   */
  private initializeVoiceRouter(): void {
    const apiKey = this.config.api_key || process.env[`${this.config.provider.toUpperCase()}_API_KEY`] || ""

    this.router = new VoiceRouter({
      providers: {
        [this.config.provider]: { apiKey }
      },
      defaultProvider: this.config.provider as TranscriptionProvider
    })

    // Register the appropriate adapter based on provider
    switch (this.config.provider) {
      case "gladia":
        this.router.registerAdapter(new GladiaAdapter())
        break
      case "deepgram":
        this.router.registerAdapter(new DeepgramAdapter())
        break
      case "assemblyai":
        this.router.registerAdapter(new AssemblyAIAdapter())
        break
    }
  }

  /**
   * Connect to user's WebSocket for transcript delivery
   */
  private async connectToUserWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.userWebSocket = new WebSocket(this.config.output_url)

        this.userWebSocket.on("open", () => {
          console.log(`✅ Connected to user's transcript WebSocket: ${this.config.output_url}`)

          // Send ready event with session info
          this.sendToUser({
            type: "ready",
            session_id: this.botId,
            provider: this.config.provider,
            timestamp: Date.now()
          })

          resolve()
        })

        this.userWebSocket.on("error", (error) => {
          console.error("User WebSocket error:", error)
          if (!this.isInitialized) {
            reject(error)
          }
        })

        this.userWebSocket.on("close", (code, reason) => {
          console.log(`User WebSocket closed: ${code} - ${reason}`)
          this.handleUserWebSocketClose()
        })

        // Set connection timeout
        setTimeout(() => {
          if (this.userWebSocket?.readyState !== WebSocket.OPEN) {
            reject(new Error("WebSocket connection timeout"))
          }
        }, 10000)
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Handle user WebSocket close - attempt reconnection
   */
  private async handleUserWebSocketClose(): Promise<void> {
    if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++
      console.log(`Attempting to reconnect to user WebSocket (${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`)

      await new Promise((resolve) => setTimeout(resolve, 1000 * this.reconnectAttempts))

      try {
        await this.connectToUserWebSocket()
        this.reconnectAttempts = 0
      } catch (error) {
        console.error("Reconnection failed:", error)
      }
    } else {
      console.error("Max reconnection attempts reached, stopping transcription streaming")
    }
  }

  /**
   * Start the transcription stream using VoiceRouter
   */
  private async startTranscriptionStream(): Promise<void> {
    if (!this.router) {
      throw new Error("VoiceRouter not initialized")
    }

    const options = this.config.options

    // Map encoding to VoiceRouter-compatible format
    const encodingMap: Record<string, string> = {
      linear16: "linear16",
      pcm_s16le: "linear16",
      mulaw: "mulaw",
      alaw: "alaw",
      flac: "flac",
      opus: "opus"
    }
    const encoding = encodingMap[this.config.encoding] || "linear16"

    // Build streaming options - use type assertion for SDK compatibility
    const streamingOptions = {
      encoding,
      sampleRate: Number.parseInt(this.config.sample_rate, 10),
      ...(options?.language && { language: options.language }),
      interimResults: options?.interim_results ?? true,
      ...(options?.diarization && { diarization: true }),
      ...(options?.word_timestamps && { wordTimestamps: true }),
      ...(options?.punctuation !== undefined && { punctuation: options.punctuation }),
      ...(options?.profanity_filter && { profanityFilter: true }),
      ...(options?.custom_vocabulary && { customVocabulary: options.custom_vocabulary }),
      ...(options?.endpointing_ms && { endpointing: options.endpointing_ms })
    }

    // Build callbacks
    const callbacks = {
      onOpen: () => {
        console.log("🎙️ VoiceRouter streaming session opened")
      },
      onTranscript: (event: unknown) => {
        this.handleTranscript(event as TranscriptFromSDK)
      },
      onError: (error: unknown) => {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error("VoiceRouter streaming error:", errorMsg)
        this.sendErrorToUser("TRANSCRIPTION_ERROR", errorMsg || "Transcription error")
      },
      onClose: (code?: number, reason?: string) => {
        console.log(`VoiceRouter streaming closed: ${code} - ${reason}`)
        this.sendToUser({
          type: "closed",
          session_id: this.botId,
          timestamp: Date.now()
        })
      }
    }

    // Start streaming session with VoiceRouter
    // Use the provider configured in the router (set during initialization)
    this.session = await this.router.transcribeStream(
      streamingOptions as Parameters<typeof this.router.transcribeStream>[0],
      callbacks as Parameters<typeof this.router.transcribeStream>[1]
    )
  }

  /**
   * Handle transcript events from VoiceRouter SDK
   */
  private handleTranscript(event: TranscriptFromSDK): void {
    if (!event.text) return

    const transcriptEvent: TranscriptEvent = {
      type: "transcript",
      session_id: this.botId,
      provider: this.config.provider,
      text: event.text,
      is_final: event.isFinal ?? false,
      timestamp: Date.now()
    }

    // Add optional fields if present
    if (event.speaker) {
      transcriptEvent.speaker = event.speaker
    }
    if (event.confidence !== undefined) {
      transcriptEvent.confidence = event.confidence
    }
    // Map words from SDK format (may use 'text' or 'word' for the word content)
    if (event.words && event.words.length > 0) {
      transcriptEvent.words = event.words.map((w) => ({
        word: w.word || w.text || "",
        start: w.start ?? 0,
        end: w.end ?? 0,
        confidence: w.confidence ?? 1
      }))
    }

    this.sendToUser(transcriptEvent)
  }

  /**
   * Process incoming audio chunk
   * Called by Streaming class when new audio is captured
   */
  public processAudioChunk(audioData: Float32Array): void {
    if (!this.isInitialized || !this.session) {
      return
    }

    // Convert Float32Array to Int16Array (linear16 format)
    const int16Data = new Int16Array(audioData.length)
    for (let i = 0; i < audioData.length; i++) {
      const sample = Math.max(-1, Math.min(1, audioData[i]))
      int16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }

    // Buffer audio for batch sending (reduces network overhead)
    this.audioBuffer.push(Buffer.from(int16Data.buffer))

    if (this.audioBuffer.length >= this.AUDIO_BUFFER_SIZE) {
      this.flushAudioBuffer()
    }
  }

  /**
   * Flush buffered audio to VoiceRouter
   */
  private flushAudioBuffer(): void {
    if (this.audioBuffer.length === 0 || !this.session) return

    // Combine all buffered chunks
    const combinedBuffer = Buffer.concat(this.audioBuffer)
    this.audioBuffer = []

    // Send to VoiceRouter
    this.session.sendAudio({ data: combinedBuffer }).catch((error) => {
      console.error("Failed to send audio to VoiceRouter:", error)
    })
  }

  /**
   * Send event to user's WebSocket
   */
  private sendToUser(event: TranscriptEvent): void {
    if (this.userWebSocket?.readyState === WebSocket.OPEN) {
      try {
        this.userWebSocket.send(JSON.stringify(event))
      } catch (error) {
        console.error("Failed to send to user WebSocket:", error)
      }
    }
  }

  /**
   * Send error event to user
   */
  private sendErrorToUser(code: string, message: string): void {
    this.sendToUser({
      type: "error",
      session_id: this.botId,
      error: { code, message },
      timestamp: Date.now()
    })
  }

  /**
   * Stop the streaming transcription service
   */
  public async stop(): Promise<void> {
    if (!this.isInitialized) {
      return
    }

    console.log("🛑 Stopping streaming transcription...")

    // Flush any remaining audio
    this.flushAudioBuffer()

    // Close VoiceRouter session
    if (this.session) {
      try {
        await this.session.close()
      } catch (error) {
        console.error("Error closing VoiceRouter session:", error)
      }
      this.session = null
    }

    // Close user WebSocket
    if (this.userWebSocket) {
      try {
        if (this.userWebSocket.readyState === WebSocket.OPEN) {
          this.sendToUser({
            type: "closed",
            session_id: this.botId,
            timestamp: Date.now()
          })
          this.userWebSocket.close(1000, "Transcription ended")
        }
      } catch (error) {
        console.error("Error closing user WebSocket:", error)
      }
      this.userWebSocket = null
    }

    this.router = null
    this.isInitialized = false
    this.audioBuffer = []

    console.log("✅ Streaming transcription stopped")
  }

  /**
   * Check if streaming transcription is active
   */
  public isActive(): boolean {
    return this.isInitialized && this.session !== null
  }
}
