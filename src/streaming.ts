import * as fs from "node:fs"
import { Readable } from "node:stream"
import { type RawData, WebSocket, WebSocketServer } from "ws"

import { SoundContext } from "./media_context"
import type { SpeakerData } from "./types"
import { formatError } from "./utils/Logger"
import { PathManager } from "./utils/PathManager"
import { S3Uploader } from "./utils/S3Uploader"

const DEFAULT_SAMPLE_RATE: number = 24_000

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
  public sample_rate: number = DEFAULT_SAMPLE_RATE

  // Configuration parameters
  private inputUrl: string | undefined
  private outputUrl: string | undefined
  private botId: string

  // Streaming state management
  private isInitialized = false
  private isPaused = false
  private pausedChunks: RawData[] = []

  // Browser audio streaming
  private sourceSampleRate = 48000 // Default, updated by incoming chunks
  private browserAudioChunksSent = 0
  private lastBrowserStatsLogTime = 0

  // WebSocket connection buffer (for chunks received before WS is ready)
  private connectionBuffer: Float32Array[] = []
  private wsConnectionStartTime = 0

  // WebSocket reconnection with exponential backoff
  private isReconnecting = false
  private reconnectAttempts = 0
  private reconnectTimeoutId: NodeJS.Timeout | null = null
  private readonly INITIAL_RECONNECT_DELAY_MS: number = 1000 // 1 second
  private readonly MAX_RECONNECT_DELAY_MS: number = 60000 // 1 minute
  private lastWsNotReadyLogTime = 0
  private readonly WS_NOT_READY_LOG_INTERVAL_MS: number = 10000 // Log at most every 10 seconds

  // Local WebSocket server for binary audio from browser
  private static readonly LOCAL_AUDIO_WS_PORT = 9321
  private localWsServer: WebSocketServer | null = null
  public localAudioPort = 0

  // Stateful resampler (carries filter tail across chunks to avoid boundary artifacts)
  private resamplerState: Float32Array | null = null
  private static readonly RESAMPLER_LOBES = 4

  // Fixed-size output buffer (accumulates resampled Int16 into consistent chunks)
  private static readonly OUTPUT_CHUNK_MS = 100 // 100ms chunks, same as Attendee
  private outputBuffer: Int16Array | null = null
  private outputBufferOffset = 0

  // Debug: Save streamed audio to file
  private debugAudioStream: fs.WriteStream | null = null
  private debugAudioBytesWritten = 0
  private readonly debugAudioEnabled: boolean = process.env.DEBUG_AUDIO === "true"

  constructor(
    input: string | undefined,
    output: string | undefined,
    sample_rate: number | undefined,
    bot_id: string
  ) {
    this.inputUrl = input
    this.outputUrl = output
    this.botId = bot_id

    if (sample_rate) {
      this.sample_rate = sample_rate
    }

    console.log(
      `🎵 Streaming service initialized with sample rate: ${this.sample_rate} Hz${sample_rate ? " (from user config)" : ` (default: ${DEFAULT_SAMPLE_RATE} Hz)`}`
    )
    if (this.debugAudioEnabled) {
      console.log("🐛 Debug audio file recording enabled (DEBUG_AUDIO=true)")
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
      console.warn("Streaming service already started")
      return
    }

    console.log("🎵 Starting simplified streaming service (direct audio processing)")

    // Setup external output WebSocket if configured
    if (this.outputUrl) {
      this.setupExternalOutputWS()
    }

    // Setup external input WebSocket if configured
    if (this.inputUrl && this.outputUrl !== this.inputUrl) {
      this.setupExternalInputWS()
    }

    // Start local WebSocket server for binary audio from browser
    this.startLocalAudioServer()

    this.isInitialized = true
    this.isPaused = false

    console.log("✅ Streaming service ready for direct audio processing")
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
      console.warn("[Streaming] ⚠️ Received audio chunk but streaming not initialized")
      return
    }

    if (!this.output_ws || this.output_ws.readyState !== WebSocket.OPEN) {
      // Throttle warning logs to avoid spam
      const now = Date.now()
      if (now - this.lastWsNotReadyLogTime >= this.WS_NOT_READY_LOG_INTERVAL_MS) {
        console.warn(
          "[Streaming] ⚠️ WebSocket not ready, discarding audio chunks (state:",
          this.output_ws?.readyState,
          ")"
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
          `🎵 [Streaming] First audio chunk received from browser: ${audioChunk.numberOfFrames} frames @ ${audioChunk.sampleRate} Hz`
        )
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
      console.error("[Streaming] Failed to process mixed audio chunk:", formatError(error))
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
      s16Array[i] = Math.round(Math.max(-32768, Math.min(32767, finalBuffer[i] * 32768)))
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
      `📤 Flushing connection buffer: ${bufferSize} chunks (~${(bufferSize * 0.04).toFixed(2)}s of audio)`
    )

    for (const chunk of this.connectionBuffer) {
      const s16Array = new Int16Array(chunk.length)
      for (let i = 0; i < chunk.length; i++) {
        s16Array[i] = Math.round(Math.max(-32768, Math.min(32767, chunk[i] * 32768)))
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

      this.output_ws.on("open", () => {
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
            sample_rate: this.sample_rate
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

      this.output_ws.on("error", (err: Error) => {
        console.error("External output WebSocket error:", formatError(err))
        // Schedule reconnection on error
        this.scheduleReconnect()
      })

      this.output_ws.on("close", () => {
        console.log("External output WebSocket closed")
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
      console.error("Failed to setup external output WebSocket:", formatError(error))
    }
  }

  /**
   * Setup external input WebSocket (for external services)
   */
  private setupExternalInputWS(): void {
    try {
      this.input_ws = new WebSocket(this.inputUrl!)

      this.input_ws.on("open", () => {
        console.log("✅ External input WebSocket connected")
      })

      this.input_ws.on("error", (err: Error) => {
        console.error("External input WebSocket error:", formatError(err))
      })

      this.play_incoming_audio_chunks(this.input_ws)
    } catch (error) {
      console.error("Failed to setup external input WebSocket:", formatError(error))
    }
  }

  /**
   * Start local WebSocket server for receiving binary audio from browser.
   * The browser sends pre-processed Int16 PCM chunks over a binary WebSocket
   * instead of JSON-serialized Float32 arrays through Playwright's exposeFunction.
   * This eliminates the JSON serialization overhead and reduces main thread blocking.
   */
  private startLocalAudioServer(): void {
    if (!this.outputUrl) return

    try {
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: Streaming.LOCAL_AUDIO_WS_PORT
      })

      wss.on("connection", (ws) => {
        console.log("[Streaming] Browser audio connected via local WebSocket (binary mode)")

        ws.on("message", (data: Buffer, isBinary: boolean) => {
          // Text message: sample rate handshake from browser
          if (!isBinary) {
            try {
              const msg = JSON.parse(data.toString())
              if (msg.sampleRate && msg.sampleRate > 0) {
                this.sourceSampleRate = msg.sampleRate
                // Initialize output buffer based on target sample rate
                const chunkSamples = Math.floor(
                  this.sample_rate * (Streaming.OUTPUT_CHUNK_MS / 1000)
                )
                this.outputBuffer = new Int16Array(chunkSamples)
                this.outputBufferOffset = 0
                // Reset resampler state for new connection
                this.resamplerState = null
                console.log(
                  `[Streaming] Source sample rate: ${this.sourceSampleRate} Hz, ` +
                    `target: ${this.sample_rate} Hz, ` +
                    `output chunk: ${chunkSamples} samples (${Streaming.OUTPUT_CHUNK_MS}ms)`
                )
              }
            } catch {
              // Ignore malformed text messages
            }
            return
          }

          // Binary message: raw Float32 audio from browser at source sample rate
          // Copy to aligned buffer — WebSocket Buffer byteOffset may not be 4-byte aligned
          const aligned = new Uint8Array(data.byteLength)
          aligned.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
          const float32Data = new Float32Array(aligned.buffer)

          // Resample with stateful filter (carries tail across chunks)
          const resampled = this.resampleStateful(float32Data)

          // Convert to Int16
          const int16Chunk = new Int16Array(resampled.length)
          for (let i = 0; i < resampled.length; i++) {
            const s = Math.max(-1, Math.min(1, resampled[i]))
            int16Chunk[i] = Math.round(s * 32767)
          }

          // Buffer into fixed-size chunks and send
          this.bufferAndSend(int16Chunk)
        })

        ws.on("error", (err) => {
          console.error("[Streaming] Local audio WebSocket error:", formatError(err))
        })
      })

      wss.on("error", (err) => {
        console.error("[Streaming] Local audio WS server error:", formatError(err))
      })

      this.localWsServer = wss
      this.localAudioPort = Streaming.LOCAL_AUDIO_WS_PORT
      console.log(
        `[Streaming] Local audio WS server listening on 127.0.0.1:${this.localAudioPort}`
      )
    } catch (error) {
      console.error("[Streaming] Failed to start local audio WS server:", formatError(error))
    }
  }

  /**
   * Stateful Lanczos windowed-sinc resampler.
   * Carries a tail buffer of samples from the previous chunk so the filter
   * always has full context at chunk boundaries — no clicks or discontinuities.
   */
  private resampleStateful(input: Float32Array): Float32Array {
    const sourceRate = this.sourceSampleRate
    const targetRate = this.sample_rate

    if (sourceRate === targetRate) return input

    const LOBES = Streaming.RESAMPLER_LOBES
    const ratio = sourceRate / targetRate

    // Prepend tail from previous chunk for filter context at the boundary
    const tail = this.resamplerState
    const tailLen = tail ? tail.length : 0
    const extended = new Float32Array(tailLen + input.length)
    if (tail) extended.set(tail, 0)
    extended.set(input, tailLen)

    // Compute output samples using the extended buffer
    // Output positions are relative to the start of `input` (offset by tailLen)
    const outputLen = Math.floor(input.length / ratio)
    const output = new Float32Array(outputLen)

    for (let i = 0; i < outputLen; i++) {
      // srcPos is relative to the start of `input`, offset into extended buffer
      const srcPos = i * ratio + tailLen
      const srcIdx = Math.floor(srcPos)
      let sample = 0
      let wSum = 0

      for (let j = -LOBES + 1; j <= LOBES; j++) {
        const idx = srcIdx + j
        if (idx < 0 || idx >= extended.length) continue
        const x = srcPos - idx
        let w: number

        if (Math.abs(x) < 1e-6) {
          w = 1.0
        } else if (Math.abs(x) < LOBES) {
          const px = Math.PI * x
          w = (Math.sin(px) / px) * (Math.sin(px / LOBES) / (px / LOBES))
        } else {
          w = 0
        }

        sample += extended[idx] * w
        wSum += w
      }

      output[i] = wSum > 0 ? sample / wSum : 0
    }

    // Save the last LOBES*2 samples as tail for next chunk
    const newTailLen = Math.min(LOBES * 2, input.length)
    this.resamplerState = input.slice(input.length - newTailLen)

    return output
  }

  /**
   * Buffer resampled Int16 samples into fixed-size chunks (e.g. 100ms)
   * and send each complete chunk to the output WebSocket.
   * This ensures the client receives predictably-sized frames.
   */
  private bufferAndSend(samples: Int16Array): void {
    if (!this.outputBuffer) {
      // Not initialized yet (no sample rate handshake received)
      return
    }

    let offset = 0
    while (offset < samples.length) {
      const remaining = this.outputBuffer.length - this.outputBufferOffset
      const toCopy = Math.min(remaining, samples.length - offset)

      this.outputBuffer.set(samples.subarray(offset, offset + toCopy), this.outputBufferOffset)
      this.outputBufferOffset += toCopy
      offset += toCopy

      // When buffer is full, send the chunk
      if (this.outputBufferOffset >= this.outputBuffer.length) {
        this.sendOutputChunk(this.outputBuffer)
        this.outputBufferOffset = 0
      }
    }
  }

  /**
   * Send a complete fixed-size Int16 PCM chunk to the output WebSocket.
   */
  private sendOutputChunk(chunk: Int16Array): void {
    if (!this.output_ws || this.output_ws.readyState !== WebSocket.OPEN) {
      const now = Date.now()
      if (now - this.lastWsNotReadyLogTime >= this.WS_NOT_READY_LOG_INTERVAL_MS) {
        console.warn("[Streaming] Output WebSocket not ready, discarding audio")
        this.lastWsNotReadyLogTime = now
      }
      this.scheduleReconnect()
      return
    }

    this.output_ws.send(chunk.buffer)
    this.browserAudioChunksSent++

    // Stats logging
    const now = Date.now()
    if (now - this.lastBrowserStatsLogTime > 5000) {
      console.log(
        `📊 [Streaming] Sent ${this.browserAudioChunksSent} chunks to WebSocket (${Streaming.OUTPUT_CHUNK_MS}ms each)`
      )
      this.lastBrowserStatsLogTime = now
    }

    // Debug audio file
    if (this.debugAudioEnabled && this.debugAudioStream) {
      this.writeDebugAudioChunk(chunk)
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
      this.INITIAL_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      this.MAX_RECONNECT_DELAY_MS
    )

    console.log(
      `🔄 Scheduling WebSocket reconnection attempt ${this.reconnectAttempts} in ${(delay / 1000).toFixed(1)}s`
    )

    // Clear any existing timeout
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId)
    }

    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = null

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
      console.warn("Cannot pause: streaming service not started")
      return
    }

    if (this.isPaused) {
      console.warn("Streaming service already paused")
      return
    }

    this.isPaused = true
    console.log("🔇 Streaming paused")
  }

  public resume(): void {
    if (!this.isInitialized) {
      console.warn("Cannot resume: streaming service not started")
      return
    }

    if (!this.isPaused) {
      console.warn("Streaming service not paused")
      return
    }

    this.isPaused = false
    this.processPausedChunks()
    console.log("🔊 Streaming resumed")
  }

  /**
   * Simplified stop method - no more extension WebSocket cleanup
   */
  public async stop(): Promise<void> {
    if (!this.isInitialized) {
      console.warn("Cannot stop: streaming service not started")
      return
    }

    console.log("🛑 Stopping simplified streaming service...")

    // Finalize debug audio file (wait for WAV header to be written)
    await this.finalizeDebugAudioFile()

    // Close local audio WS server
    if (this.localWsServer) {
      this.localWsServer.close()
      this.localWsServer = null
    }

    // Reset resampler and output buffer
    this.resamplerState = null
    this.outputBuffer = null
    this.outputBufferOffset = 0

    // Close external WebSockets only
    this.closeExternalWebSockets()

    // Reset state
    this.isInitialized = false
    this.isPaused = false
    this.pausedChunks = []
    Streaming.instance = null

    console.log("✅ Streaming service stopped successfully")
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
      console.error("Error closing external output WebSocket:", formatError(error))
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
      console.error("Error closing external input WebSocket:", formatError(error))
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
        if (this.output_ws && this.output_ws.readyState === WebSocket.OPEN) {
          const s16Array = new Int16Array(f32Array.length)
          for (let i = 0; i < f32Array.length; i++) {
            s16Array[i] = Math.round(Math.max(-32768, Math.min(32767, f32Array[i] * 32768)))
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
    const stdin = SoundContext.instance.play_stdin()
    const audio_stream = this.createAudioStreamFromWebSocket(input_ws)

    audio_stream.on("data", (chunk) => {
      stdin.write(chunk)
    })

    audio_stream.on("end", () => {
      stdin.end()
    })
  }

  private createAudioStreamFromWebSocket = (input_ws: WebSocket) => {
    const stream = new Readable({
      read() {}
    })

    input_ws.on("message", (message: RawData) => {
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
          console.error("Error processing external audio chunk:", formatError(error))
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
      console.error("Failed to initialize debug audio file:", formatError(error))
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
    bitsPerSample: number
  ): Buffer {
    const header = Buffer.alloc(44)

    // RIFF header
    header.write("RIFF", 0)
    header.writeUInt32LE(36 + dataSize, 4) // File size - 8
    header.write("WAVE", 8)

    // fmt chunk
    header.write("fmt ", 12)
    header.writeUInt32LE(16, 16) // fmt chunk size
    header.writeUInt16LE(1, 20) // Audio format (1 = PCM)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28) // Byte rate
    header.writeUInt16LE((channels * bitsPerSample) / 8, 32) // Block align
    header.writeUInt16LE(bitsPerSample, 34)

    // data chunk
    header.write("data", 36)
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
      console.error("Failed to write debug audio chunk:", formatError(error))
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
        let fd: fs.promises.FileHandle | null = null
        try {
          // Update WAV header with correct size using async file operations
          fd = await fs.promises.open(debugPath, "r+")
          const header = this.createWavHeader(bytesWritten, sampleRate, 1, 16)
          await fd.write(new Uint8Array(header), 0, 44, 0)

          console.log(
            `🎤 Debug: Streamed audio saved to ${debugPath} (${(bytesWritten / 1024).toFixed(1)} KB)`
          )

          // Upload debug audio to S3 logs bucket
          try {
            const s3Path = `${this.botId}/debug_streamed_audio.wav`
            await S3Uploader.getInstance().uploadToDefaultBucket(debugPath, s3Path)
            console.log(`🎤 Debug: Uploaded debug audio to S3: ${s3Path}`)
          } catch (uploadError) {
            console.error("Failed to upload debug audio to S3:", formatError(uploadError))
          }

          resolve()
        } catch (error) {
          console.error("Failed to update WAV header:", formatError(error))
          reject(error)
        } finally {
          // Always close the file descriptor
          if (fd) {
            try {
              await fd.close()
            } catch (closeError) {
              console.error("Failed to close debug audio file:", formatError(closeError))
            }
          }
        }
      })
    })
  }
}
