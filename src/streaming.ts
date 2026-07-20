import { type ChildProcess, spawn } from "node:child_process"
import * as fs from "node:fs"
import { Readable } from "node:stream"
import { type RawData, WebSocket } from "ws"

import { envVars } from "./config/env-vars"
import { SoundContext } from "./media_context"
import type { SpeakerData } from "./types"
import { formatError } from "./utils/Logger"
import { PathManager } from "./utils/PathManager"
import { S3Uploader } from "./utils/S3Uploader"

const DEFAULT_SAMPLE_RATE: number = 24_000

/**
 * Streaming class for real-time audio output to external services
 *
 * Audio source: Dedicated FFmpeg process capturing from PulseAudio.
 * A lightweight audio-only FFmpeg (no video encoding) outputs Float32 PCM
 * at the target sample rate to stdout. This avoids contention with the main
 * ScreenRecorder FFmpeg (which handles x264 + screenshots + audio file)
 * and provides steady real-time audio delivery.
 *
 * IMPORTANT: This is an OPTIONAL feature, completely independent of:
 * - Sound level monitoring (handled by SoundLevelMonitor)
 * - Automatic leave detection (uses SoundLevelMonitor)
 * - Recording (handled by ScreenRecorder)
 */
export class Streaming {
  public static instance: Streaming | null = null

  // External services WebSockets
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

  // Audio chunk stats
  private chunksSent = 0
  private lastStatsLogTime = 0

  // WebSocket connection state
  private wsConnectionStartTime = 0

  // WebSocket reconnection with exponential backoff
  private isReconnecting = false
  private reconnectAttempts = 0
  private reconnectTimeoutId: NodeJS.Timeout | null = null
  private readonly INITIAL_RECONNECT_DELAY_MS: number = 1000 // 1 second
  private readonly MAX_RECONNECT_DELAY_MS: number = 60000 // 1 minute
  private lastWsNotReadyLogTime = 0
  private readonly WS_NOT_READY_LOG_INTERVAL_MS: number = 10000 // Log at most every 10 seconds

  // Fixed-size output buffer (accumulates Int16 into consistent chunks)
  private static readonly OUTPUT_CHUNK_MS = 100 // 100ms chunks
  private outputBuffer: Int16Array | null = null
  private outputBufferOffset = 0

  // Dedicated FFmpeg process for audio capture
  private ffmpegProcess: ChildProcess | null = null
  private audioRemainder: Buffer = Buffer.alloc(0)

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
      `[Streaming] Initialized with sample rate: ${this.sample_rate} Hz${sample_rate ? " (from user config)" : ` (default: ${DEFAULT_SAMPLE_RATE} Hz)`}`
    )
    console.log("[Streaming] Audio source: dedicated FFmpeg PulseAudio capture")
    if (this.debugAudioEnabled) {
      console.log("[Streaming] Debug audio file recording enabled (DEBUG_AUDIO=true)")
    }

    this.start()

    Streaming.instance = this
  }

  public start(): void {
    if (this.isInitialized) {
      console.warn("Streaming service already started")
      return
    }

    console.log("[Streaming] Starting streaming service")

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

    console.log("[Streaming] Ready")
  }

  /**
   * Start a dedicated lightweight FFmpeg process for audio capture.
   * Captures from PulseAudio monitor and outputs Float32 PCM at the target
   * sample rate to stdout. Completely independent of the main ScreenRecorder
   * FFmpeg, so no contention with x264 encoding.
   *
   * Called from WaitingRoomState after the meeting page is opened,
   * so we don't capture pre-join audio (beep, silence, join chime).
   */
  public startAudioCapture(): void {
    if (this.ffmpegProcess) {
      console.warn("[Streaming] Audio capture already running")
      return
    }
    const source = envVars.VIRTUAL_SPEAKER_MONITOR
    const args = [
      // Low-latency input: skip probing, no input buffering
      "-probesize", "32",
      "-analyzeduration", "0",
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-f", "pulse",
      "-i", source,
      // Output: mono Float32 at target rate, flush every packet
      "-ac", "1",
      "-ar", this.sample_rate.toString(),
      "-flush_packets", "1",
      "-f", "f32le",
      "pipe:1"
    ]

    console.log(`[Streaming] Starting dedicated audio FFmpeg: ${args.join(" ")}`)

    this.ffmpegProcess = spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"]
    })

    // stdin is piped but unused; still guard it so a stray EPIPE on teardown
    // can't escalate to an uncaughtException (see media_context.ts).
    this.ffmpegProcess.stdin?.on("error", (err) => {
      console.warn(`[Streaming] ffmpeg stdin error (ignored): ${err}`)
    })

    this.ffmpegProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString().trim()
      // FFmpeg outputs diagnostic info to stderr; only log non-progress lines
      if (output && !output.match(/^size=\s*\d+/)) {
        console.log(`[Streaming FFmpeg] ${output}`)
      }
    })

    this.ffmpegProcess.on("exit", (code) => {
      console.log(`[Streaming] Audio FFmpeg exited with code ${code}`)
      this.ffmpegProcess = null
    })

    this.ffmpegProcess.on("error", (err) => {
      console.error("[Streaming] Audio FFmpeg error:", formatError(err))
      this.ffmpegProcess = null
    })

    // Handle stdout: Float32 PCM data with byte alignment
    this.ffmpegProcess.stdout?.on("data", (data: Buffer) => {
      if (this.isPaused) return

      // Handle chunk boundaries: Float32 frames can split across data events
      let buf: Buffer
      if (this.audioRemainder.length > 0) {
        buf = Buffer.concat([this.audioRemainder, data])
      } else {
        buf = data
      }

      // Only process aligned bytes (divisible by 4 for Float32)
      const alignedLen = buf.length - (buf.length % 4)
      if (alignedLen === 0) {
        this.audioRemainder = buf
        return
      }

      // Save unaligned remainder for next chunk
      this.audioRemainder = buf.subarray(alignedLen) as Buffer

      // Create Float32Array — copy to standalone array to avoid retaining pooled buffers
      const view = new Float32Array(buf.buffer, buf.byteOffset, alignedLen / 4)
      const float32Array = new Float32Array(view)

      this.processFfmpegAudioChunk(float32Array)
    })
  }

  /**
   * Stop the dedicated audio capture FFmpeg process.
   */
  private stopAudioCapture(): void {
    if (this.ffmpegProcess) {
      console.log("[Streaming] Stopping audio FFmpeg process...")
      this.ffmpegProcess.stdout?.removeAllListeners("data")
      this.ffmpegProcess.stderr?.removeAllListeners("data")
      this.ffmpegProcess.kill("SIGTERM")
      this.ffmpegProcess = null
    }
    this.audioRemainder = Buffer.alloc(0)
  }

  /**
   * Process Float32 audio from the dedicated FFmpeg stdout.
   * Converts to Int16 and buffers into fixed-size chunks for the output WebSocket.
   */
  private processFfmpegAudioChunk(data: Float32Array): void {
    // Initialize output buffer on first chunk
    if (!this.outputBuffer) {
      const chunkSamples = Math.floor(this.sample_rate * (Streaming.OUTPUT_CHUNK_MS / 1000))
      this.outputBuffer = new Int16Array(chunkSamples)
      this.outputBufferOffset = 0
      console.log(
        `[Streaming] Output buffer initialized: ${chunkSamples} samples (${Streaming.OUTPUT_CHUNK_MS}ms @ ${this.sample_rate} Hz)`
      )
    }

    // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
    const int16Chunk = new Int16Array(data.length)
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]))
      int16Chunk[i] = Math.round(s * 32767)
    }

    // Buffer into fixed-size chunks and send
    this.bufferAndSend(int16Chunk)
  }

  /**
   * Buffer Int16 samples into fixed-size chunks (e.g. 100ms)
   * and send each complete chunk to the output WebSocket.
   * This ensures the client receives predictably-sized frames.
   */
  private bufferAndSend(samples: Int16Array): void {
    if (!this.outputBuffer) return

    let offset = 0
    while (offset < samples.length) {
      const remaining = this.outputBuffer.length - this.outputBufferOffset
      const toCopy = Math.min(remaining, samples.length - offset)

      this.outputBuffer.set(samples.subarray(offset, offset + toCopy), this.outputBufferOffset)
      this.outputBufferOffset += toCopy
      offset += toCopy

      // When buffer is full, send a copy and allocate a fresh buffer.
      // We must NOT reuse the same ArrayBuffer because ws.send() and
      // stream.write() are async — they hold a zero-copy view (Buffer.from(ArrayBuffer))
      // that would be corrupted if we overwrote the buffer before I/O completes.
      if (this.outputBufferOffset >= this.outputBuffer.length) {
        this.sendOutputChunk(this.outputBuffer)
        this.outputBuffer = new Int16Array(this.outputBuffer.length)
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
    this.chunksSent++

    // Stats logging every 5 seconds
    const now = Date.now()
    if (now - this.lastStatsLogTime > 5000) {
      const chunkSamples = this.outputBuffer?.length || 0
      const totalSamples = this.chunksSent * chunkSamples
      const totalSeconds = totalSamples / this.sample_rate
      console.log(
        `[Streaming] tx=${this.chunksSent} chunks (${Streaming.OUTPUT_CHUNK_MS}ms), ` +
          `total=${totalSeconds.toFixed(1)}s of audio`
      )
      this.lastStatsLogTime = now
    }

    // Debug audio file
    if (this.debugAudioEnabled && this.debugAudioStream) {
      this.writeDebugAudioChunk(chunk)
    }
  }

  /**
   * Setup external output WebSocket (for external services)
   */
  private setupExternalOutputWS(): void {
    try {
      console.log(`[Streaming] Connecting to external output WebSocket: ${this.outputUrl}`)
      this.output_ws = new WebSocket(this.outputUrl!)
      this.wsConnectionStartTime = Date.now()

      this.output_ws.on("open", () => {
        const connectionTime = Date.now() - this.wsConnectionStartTime
        console.log(`[Streaming] External output WebSocket connected in ${connectionTime}ms`)

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
          console.log(`[Streaming] Sending handshake to ${this.outputUrl}: ${JSON.stringify(handshake)}`)
          this.output_ws.send(JSON.stringify(handshake))

          // Initialize debug audio file if enabled
          if (this.debugAudioEnabled) {
            this.initDebugAudioFile()
          }
        }
      })

      this.output_ws.on("error", (err: Error) => {
        console.error("[Streaming] External output WebSocket error:", formatError(err))
        this.scheduleReconnect()
      })

      this.output_ws.on("close", () => {
        console.log("[Streaming] External output WebSocket closed")
        if (this.isInitialized) {
          this.scheduleReconnect()
        }
      })

      // Handle dual channel (input/output same URL)
      if (this.inputUrl === this.outputUrl) {
        this.play_incoming_audio_chunks(this.output_ws)
      }
    } catch (error) {
      console.error("[Streaming] Failed to setup external output WebSocket:", formatError(error))
    }
  }

  /**
   * Setup external input WebSocket (for external services)
   */
  private setupExternalInputWS(): void {
    try {
      this.input_ws = new WebSocket(this.inputUrl!)

      this.input_ws.on("open", () => {
        console.log("[Streaming] External input WebSocket connected")
      })

      this.input_ws.on("error", (err: Error) => {
        console.error("[Streaming] External input WebSocket error:", formatError(err))
      })

      this.play_incoming_audio_chunks(this.input_ws)
    } catch (error) {
      console.error("[Streaming] Failed to setup external input WebSocket:", formatError(error))
    }
  }

  /**
   * Schedule WebSocket reconnection with exponential backoff
   * Max delay is 1 minute between reconnection attempts
   */
  private scheduleReconnect(): void {
    if (!this.isInitialized || !this.outputUrl) return
    if (this.isReconnecting) return

    if (
      this.output_ws &&
      (this.output_ws.readyState === WebSocket.OPEN ||
        this.output_ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    this.isReconnecting = true
    this.reconnectAttempts++

    const delay = Math.min(
      this.INITIAL_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      this.MAX_RECONNECT_DELAY_MS
    )

    console.log(
      `[Streaming] Scheduling WebSocket reconnection attempt ${this.reconnectAttempts} in ${(delay / 1000).toFixed(1)}s`
    )

    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId)
    }

    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = null

      if (!this.isInitialized || !this.outputUrl) {
        this.isReconnecting = false
        return
      }

      console.log(`[Streaming] Attempting WebSocket reconnection (attempt ${this.reconnectAttempts})...`)
      this.isReconnecting = false
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
    console.log("[Streaming] Paused")
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
    console.log("[Streaming] Resumed")
  }

  public async stop(): Promise<void> {
    if (!this.isInitialized) {
      console.warn("Cannot stop: streaming service not started")
      return
    }

    console.log("[Streaming] Stopping streaming service...")

    // Stop dedicated audio capture
    this.stopAudioCapture()

    // Finalize debug audio file (wait for WAV header to be written)
    await this.finalizeDebugAudioFile()

    // Reset output buffer
    this.outputBuffer = null
    this.outputBufferOffset = 0

    // Close external WebSockets
    this.closeExternalWebSockets()

    // Reset state
    this.isInitialized = false
    this.isPaused = false
    this.pausedChunks = []
    Streaming.instance = null

    console.log("[Streaming] Stopped successfully")
  }

  private closeExternalWebSockets(): void {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId)
      this.reconnectTimeoutId = null
    }
    this.isReconnecting = false
    this.reconnectAttempts = 0

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
      console.error("[Streaming] Error closing external output WebSocket:", formatError(error))
      this.output_ws = null
    }

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
      console.error("[Streaming] Error closing external input WebSocket:", formatError(error))
      this.input_ws = null
    }
  }

  public send_speaker_state(speakers: SpeakerData[]): void {
    if (!this.isInitialized || !this.outputUrl) return
    if (this.isPaused) return

    if (this.output_ws?.readyState === WebSocket.OPEN) {
      this.output_ws.send(JSON.stringify(speakers))
    }
  }

  private processPausedChunks(): void {
    if (this.pausedChunks.length === 0) return

    for (const message of this.pausedChunks) {
      if (message instanceof Buffer) {
        const uint8Array = new Uint8Array(message)
        const f32Array = new Float32Array(uint8Array.buffer)

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

  // External audio injection (for bidirectional streaming)
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
      if (this.isPaused) return

      if (message instanceof Buffer) {
        const uint8Array = new Uint8Array(message)
        try {
          const s16Array = new Int16Array(uint8Array.buffer)
          const f32Array = new Float32Array(s16Array.length)
          for (let i = 0; i < s16Array.length; i++) {
            f32Array[i] = s16Array[i] / 32768
          }

          const buffer = Buffer.from(f32Array.buffer)
          stream.push(buffer)
        } catch (error) {
          console.error("[Streaming] Error processing external audio chunk:", formatError(error))
        }
      }
    })

    return stream
  }

  /**
   * Initialize debug audio file for saving streamed audio.
   * Single file: debug_streamed_audio.wav at target sample rate.
   * (No separate raw file needed — ffmpeg already outputs at target rate)
   */
  private initDebugAudioFile(): void {
    try {
      const debugPath = PathManager.getInstance().getDebugStreamedAudioPath()
      console.log(`[Streaming] Debug: Saving streamed audio to ${debugPath}`)

      this.debugAudioStream = fs.createWriteStream(debugPath)
      this.debugAudioBytesWritten = 0

      const header = this.createWavHeader(0, this.sample_rate, 1, 16)
      this.debugAudioStream.write(header)
    } catch (error) {
      console.error("[Streaming] Failed to initialize debug audio file:", formatError(error))
      this.debugAudioStream = null
    }
  }

  private createWavHeader(
    dataSize: number,
    sampleRate: number,
    channels: number,
    bitsPerSample: number
  ): Buffer {
    const header = Buffer.alloc(44)

    header.write("RIFF", 0)
    header.writeUInt32LE(36 + dataSize, 4)
    header.write("WAVE", 8)

    header.write("fmt ", 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28)
    header.writeUInt16LE((channels * bitsPerSample) / 8, 32)
    header.writeUInt16LE(bitsPerSample, 34)

    header.write("data", 36)
    header.writeUInt32LE(dataSize, 40)

    return header
  }

  private writeDebugAudioChunk(audioData: Int16Array): void {
    if (!this.debugAudioStream) return

    try {
      const buffer = Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength)
      this.debugAudioStream.write(buffer)
      this.debugAudioBytesWritten += buffer.length
    } catch (error) {
      console.error("[Streaming] Failed to write debug audio chunk:", formatError(error))
    }
  }

  private async finalizeWavFile(
    filePath: string,
    bytesWritten: number,
    sampleRate: number,
    stream: fs.WriteStream,
    s3FileName: string
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream.end(async () => {
        let fd: fs.promises.FileHandle | null = null
        try {
          fd = await fs.promises.open(filePath, "r+")
          const header = this.createWavHeader(bytesWritten, sampleRate, 1, 16)
          await fd.write(new Uint8Array(header), 0, 44, 0)

          console.log(
            `[Streaming] Debug: ${s3FileName} saved to ${filePath} (${(bytesWritten / 1024).toFixed(1)} KB)`
          )

          try {
            const s3Path = `${this.botId}/${s3FileName}`
            await S3Uploader.getInstance().uploadToDefaultBucket(filePath, s3Path)
            console.log(`[Streaming] Debug: Uploaded to S3: ${s3Path}`)
          } catch (uploadError) {
            console.error(`[Streaming] Failed to upload ${s3FileName} to S3:`, formatError(uploadError))
          }

          resolve()
        } catch (error) {
          console.error(`[Streaming] Failed to finalize ${s3FileName}:`, formatError(error))
          reject(error)
        } finally {
          if (fd) {
            try {
              await fd.close()
            } catch (closeError) {
              console.error(`[Streaming] Failed to close ${s3FileName}:`, formatError(closeError))
            }
          }
        }
      })
    })
  }

  private async finalizeDebugAudioFile(): Promise<void> {
    if (!this.debugAudioStream) return

    const stream = this.debugAudioStream
    const bytesWritten = this.debugAudioBytesWritten
    this.debugAudioStream = null
    this.debugAudioBytesWritten = 0

    await this.finalizeWavFile(
      PathManager.getInstance().getDebugStreamedAudioPath(),
      bytesWritten,
      this.sample_rate,
      stream,
      "debug_streamed_audio.wav"
    )
  }
}
