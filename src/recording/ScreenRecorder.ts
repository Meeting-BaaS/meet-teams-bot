import { type ChildProcess, exec, execSync, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import { promisify } from "node:util"
import * as path from "node:path"
import type { Page } from "@playwright/test"
import { envVars } from "../config/env-vars"
import { HtmlSnapshotService } from "../services/html-snapshot-service"
import { GLOBAL } from "../singleton"
import { MeetingStateMachine } from "../state-machine/machine"
import { MeetingEndReason } from "../state-machine/types"
import { calculateVideoOffset } from "../utils/CalculVideoOffset"
import { formatError } from "../utils/Logger"
import { PathManager } from "../utils/PathManager"
import { S3Uploader } from "../utils/S3Uploader"
import { generateSyncSignal } from "../utils/SyncSignal"
import { sleep } from "../utils/sleep"
import { SoundLevelMonitor } from "../utils/sound-level-monitor"

const execAsync = promisify(exec)

const TRANSCRIPTION_CHUNK_DURATION = 7200 // Increased from 3600 to 7200, i.e. 2 hours because Gladia can now accept a 135 minutes long audio file
const GRACE_PERIOD_SECONDS = 3
// Match the 48 kHz source (Zoom → PulseAudio virtual_speaker.monitor is s16 2ch
// 48000 Hz). Using 44100 forced a 48000→44100 non-integer resample (ratio 1.0884)
// on every capture; combined with `aresample` resampler (which stretches/drops
// samples to fix drift), that warbled/garbled the recorded audio under any capture
// jitter. 48000 makes it a native passthrough — no rate conversion — so the async
// filter only corrects drift. NOTE: this is the RECORDING rate only; the WebSocket
// stream has its own independent rate (streaming.ts DEFAULT_SAMPLE_RATE / user
// config) and does NOT use this constant, so consumers are unaffected.
const AUDIO_SAMPLE_RATE = 48_000
const AUDIO_BITRATE = "192k" // Improved audio bitrate
const FLASH_SCREEN_SLEEP_TIME = 4500 // Increased from 4200 for better stability in prod
const SCREENSHOT_PERIOD = 5 // every 5 seconds instead of 2
const SCREENSHOT_WIDTH = 480 // reduced for smaller file size (fixed, not affected by RESOLUTION)
const SCREENSHOT_HEIGHT = 270 // reduced for smaller file size (fixed, not affected by RESOLUTION)
const MIN_AUDIO_CHUNK_SIZE = 100 * 1024 // 100KB

// Environment variables for display and virtual speaker monitor
const DISPLAY = envVars.DISPLAY
const VIRTUAL_SPEAKER_MONITOR = envVars.VIRTUAL_SPEAKER_MONITOR
const VIRTUAL_SPEAKER = envVars.VIRTUAL_SPEAKER

const UPLOAD_AUDIO_CHUNKS = envVars.UPLOAD_AUDIO_CHUNKS
const UPLOAD_RAW_VIDEO = envVars.UPLOAD_RAW_VIDEO

// Resolution configuration from environment variable (defaults to 720p)
function getResolution(): { width: number; height: number; captureHeight: number } {
  const resolution = envVars.RESOLUTION
  if (resolution === "1080") {
    return {
      width: 1920,
      height: 1080,
      captureHeight: 1220 // 1080 + 140px for browser bar
    }
  }
  // Default to 720p
  return {
    width: 1280,
    height: 720,
    captureHeight: 860 // 720 + 140px for browser bar
  }
}

// Dynamic timeout configuration
const FFMPEG_TIMEOUTS = {
  SIMPLE_OPERATIONS: 5 * 60 * 1000, // 5 minutes
  COMPLEX_OPERATIONS: 30 * 60 * 1000, // 30 minutes
  CRITICAL_OPERATIONS: 45 * 60 * 1000, // 45 minutes
  MAX_CEILING: 60 * 60 * 1000 // 60 minutes (1 hour ceiling)
}

/**
 * Calculate dynamic timeout for FFmpeg operations based on operation type and file size
 */
const calculateFFmpegTimeout = (operation: string, fileSizeMB?: number): number => {
  const baseTimeout = 60000 // 1 minute base

  let timeout = baseTimeout

  switch (operation) {
    case "mergeWithSync":
    case "finalTrimFromOffset":
    case "extractAudioFromVideo":
    case "createAudioChunks":
    case "createAudioChunk":
      // Critical operations: Dynamic scaling based on file size with ceiling
      timeout = Math.max(FFMPEG_TIMEOUTS.COMPLEX_OPERATIONS, (fileSizeMB || 100) * 1000)
      return Math.min(timeout, FFMPEG_TIMEOUTS.MAX_CEILING)
    case "addSilencePadding":
    case "trimAudioStart":
      // Simple audio operations
      return FFMPEG_TIMEOUTS.SIMPLE_OPERATIONS
    case "getDuration":
      // Metadata operations: dynamic scaling with modest growth
      timeout = Math.max(30000, (fileSizeMB || 100) * 100)
      return Math.min(timeout, 5 * 60 * 1000)
    default:
      // Default to complex operations timeout
      return Math.min(FFMPEG_TIMEOUTS.COMPLEX_OPERATIONS, FFMPEG_TIMEOUTS.MAX_CEILING)
  }
}

interface ScreenRecordingConfig {
  display: string
  audioDevice?: string
}

export interface AudioWarningEvent {
  type: "pulseAudioWarning"
  errorCount: number
  message: string
  timestamp: number
}

export class ScreenRecorder extends EventEmitter {
  private ffmpegProcess: ChildProcess | null = null
  private errorMonitorIntervalId: NodeJS.Timeout | null = null
  private forceKillTimeoutId: NodeJS.Timeout | null = null
  private fileSizeMonitorIntervalId: NodeJS.Timeout | null = null
  private outputPath = ""
  private audioOutputPath = ""
  private config: ScreenRecordingConfig
  private isRecording = false
  private filesUploaded = false
  private recordingStartTime = 0
  private meetingStartTime = 0
  private syncSignalTimestamp = 0 // wall-clock ms when generateSyncSignal was actually called
  private audioBeepWallMs = 0 // wall-clock ms when the WebAudio beep actually started
  private videoFlashWallMs = 0 // wall-clock ms when the flash paint committed
  private gracePeriodActive = false
  private rawAudioPath = ""
  private soundMonitorRemainder: Buffer = Buffer.alloc(0)
  private lastAudioDiagAt = 0
  private audioDiagCount = 0

  constructor(config: Partial<ScreenRecordingConfig> = {}) {
    super()

    this.config = {
      display: DISPLAY,
      audioDevice: "pulse",
      ...config
    }
  }

  private generateOutputPaths(): void {
    try {
      // Always generate both paths for consistent flow
      // Audio-only mode will just skip video upload at the end
      this.outputPath = `${PathManager.getInstance().getOutputPath()}.mp4`
      this.audioOutputPath = `${PathManager.getInstance().getOutputPath()}.flac`
    } catch (error) {
      console.error("Failed to generate output paths:", formatError(error))
      throw new Error("Failed to generate output paths")
    }
  }

  public setMeetingStartTime(startTime: number): void {
    this.meetingStartTime = startTime
  }

  public async startRecording(page: Page): Promise<void> {
    if (this.isRecording) {
      // Already recording — no-op instead of throwing. The in-process retry loop
      // relaunches the browser but the x11grab recording spans it (it captures the
      // Xvfb display, not the page), so a second start is expected. Throwing here
      // produced an unhandled rejection that crashed the pod and forced a futile
      // SQS requeue (defeating the fast in-pod retry).
      console.warn("[ScreenRecorder] startRecording called while already recording — ignoring")
      return
    }

    // Capture DOM state before starting screen recording (void to avoid blocking)
    const htmlSnapshot = HtmlSnapshotService.getInstance()
    void htmlSnapshot.captureSnapshot(page, "screen_recording_start")

    this.generateOutputPaths()

    try {
      // Wait for audio devices to be ready before starting FFmpeg
      await this.waitForAudioDevices()

      // Prime the PulseAudio monitor buffer with a short silent burst so
      // FFmpeg doesn't read an empty buffer on its first capture — a cold
      // PulseAudio null-sink has zero samples buffered, causing an initial
      // xrun/click at recording start (especially on new pods where the
      // sink was just created and no audio has flowed yet).
      try {
        await execAsync(
          `ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 0.3 -f pulse ${VIRTUAL_SPEAKER} -y 2>/dev/null`,
          { timeout: 5000 }
        )
      } catch (_e) {
        // best-effort — recording still works even if priming fails
          console.warn("[ScreenRecorder] audio buffer priming failed — initial capture may have xrun", _e)
      }

      const ffmpegArgs = this.buildNativeFFmpegArgs()

      this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
        stdio: ["pipe", "pipe", "pipe"]
      })

      // stdin is piped but unused; guard it so a stray EPIPE at kill time can't
      // escalate to an uncaughtException mid-finalization (see media_context.ts).
      this.ffmpegProcess.stdin?.on("error", (err) => {
        console.warn(`[ScreenRecorder] ffmpeg stdin error (ignored): ${err}`)
      })

      this.isRecording = true
      this.recordingStartTime = Date.now()
      this.gracePeriodActive = false
      this.logMemoryUsage("Starting recording")
      this.setupProcessMonitoring()
      this.setupSoundLevelMonitoring()
      this.setupFileSizeMonitoring()

      await sleep(FLASH_SCREEN_SLEEP_TIME)
      if (page.isClosed()) {
        // Cleanup closed the page before we reached the sync signal (pre-recording
        // stop/rejection race). Abort the start quietly — the state machine already
        // has an end_reason and will handle the failure via handleFailedRecording.
        console.warn("[ScreenRecorder] Page closed before sync signal — aborting start")
        return
      }
      // Stamp the exact wall-clock time before emitting the signal so post-processing
      // knows precisely where to look in the raw recordings — no heuristic needed.
      this.syncSignalTimestamp = Date.now()
      const syncTimestamps = await generateSyncSignal(page, {
        duration: 800, // Much longer signal for reliable detection
        frequency: 1000, // Keep 1000Hz for consistency
        volume: 0.95 // Higher volume for better detection
      })
      // Per-signal wall-clock anchors; fall back to the fire time when a
      // signal could not report its own timestamp.
      this.audioBeepWallMs = syncTimestamps.audioBeepWallMs ?? this.syncSignalTimestamp
      this.videoFlashWallMs = syncTimestamps.videoFlashWallMs ?? this.syncSignalTimestamp

      console.log("Native recording started successfully")
      this.emit("started", {
        outputPath: this.outputPath,
        isAudioOnly: GLOBAL.get().recording_mode === "audio_only"
      })
    } catch (error) {
      console.error("Failed to start native recording:", formatError(error))
      this.isRecording = false
      // If an end_reason is already set, the state machine has committed to failing
      // for a real reason (botNotAccepted, exitingMeetingBeforeRecord, etc.).
      // Emitting 'error' here would crash the process before handleFailedRecording
      // runs, because RecordingState's listener is only attached once we reach it —
      // which we won't, since cleanup is already in progress. Suppress the emit.
      if (GLOBAL.getEndReason()) {
        console.warn(
          "[ScreenRecorder] Suppressing startError — end_reason already set:",
          GLOBAL.getEndReason()
        )
        return
      }
      // No end_reason yet — unexpected. Set StreamingSetupFailed so the bot still
      // reports a failure (rather than ending up as UNKNOWN_ERROR).
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Teams-specific: "Execution context was destroyed" during sync-signal /
      // recording setup almost always means Teams redirected the page to a
      // login/auth flow mid-page.evaluate. Reclassify as LoginRequired and
      // mark retryable — if it was a transient nav, the retry recovers; if
      // login really is required, the retry hits the same wall and we end
      // up with the correct terminal status either way.
      const isTeamsNavigationDestroyedV8 =
        GLOBAL.get().meeting_platform === "teams" &&
        error instanceof Error &&
        error.message.includes("Execution context was destroyed")

      if (isTeamsNavigationDestroyedV8) {
        console.log(
          "🔄 Teams sync-signal context destruction — reclassifying as LoginRequired and marking for retry"
        )
        GLOBAL.setError(MeetingEndReason.LoginRequired, errorMessage)
        GLOBAL.setShouldRetry(true)
      } else {
        GLOBAL.setError(MeetingEndReason.StreamingSetupFailed, errorMessage)
      }
      this.emit("error", { type: "startError", error })
    }
  }

  private async waitForAudioDevices(): Promise<void> {
    const maxAttempts = 15
    const delayMs = 1000

    console.log("🔍 Waiting for audio devices to be ready...")

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Get the assigned virtual speaker monitor from environment

        // Check if the assigned virtual speaker monitor exists
        const { spawn } = await import("child_process")
        const checkProcess = spawn("pactl", ["list", "sources", "short"])

        let output = ""
        checkProcess.stdout?.on("data", (data) => {
          output += data.toString()
        })

        const exitCode = await new Promise<number>((resolve) => {
          checkProcess.on("close", resolve)
          // Without an "error" listener a spawn failure (e.g. ENOENT) is an
          // uncaughtException AND "close" never fires, hanging this await.
          checkProcess.on("error", () => resolve(-1))
        })

        if (exitCode === 0 && output.includes(VIRTUAL_SPEAKER_MONITOR)) {
          console.log(`✅ Audio device ready after ${attempt} attempt(s)`)
          return
        }

        console.log(
          `⏳ Attempt ${attempt}/${maxAttempts}: audio device not ready, waiting ${delayMs}ms...`
        )
        await sleep(delayMs)
      } catch (error) {
        console.warn(`⚠️ Attempt ${attempt}/${maxAttempts}: Error checking audio device:`, error)
        await sleep(delayMs)
      }
    }

    // If we get here, devices are still not ready - try a quick FFmpeg test
    console.warn(
      `⚠️ Audio devices not confirmed ready after ${maxAttempts} attempts, testing with FFmpeg...`
    )

    try {
      const testProcess = spawn("ffmpeg", [
        "-f",
        "pulse",
        "-i",
        VIRTUAL_SPEAKER_MONITOR,
        "-t",
        "0.1",
        "-f",
        "null",
        "-"
      ])

      const testExitCode = await new Promise<number>((resolve) => {
        testProcess.on("close", resolve)
        // Same spawn-failure guard as checkProcess above.
        testProcess.on("error", () => resolve(-1))
      })

      if (testExitCode === 0) {
        console.log("✅ FFmpeg audio test successful - devices are ready")
        return
      }
    } catch (error) {
      console.error("❌ FFmpeg audio test failed:", formatError(error))
    }

    throw new Error(
      `Audio devices not ready after maximum wait time - ${VIRTUAL_SPEAKER_MONITOR} unavailable`
    )
  }

  private buildNativeFFmpegArgs(): string[] {
    const args: string[] = []
    const res = getResolution()

    console.log(
      `🛠️ Building FFmpeg args for separate audio/video recording (resolution: ${res.width}x${res.height})...`
    )

    const screenshotsPath = PathManager.getInstance().getScreenshotsPath()
    const timestamp = Date.now()
    const screenshotPattern = path.join(screenshotsPath, `${timestamp}_%4d.png`)

    // Use the same recording flow for both audio-only and video modes
    // Audio-only mode will just skip video upload at the end
    const tempDir = PathManager.getInstance().getTempPath()
    const rawVideoPath = path.join(tempDir, "raw.mp4")
    this.rawAudioPath = path.join(tempDir, "raw.flac")

    args.push(
      // === VIDEO INPUT ===
      "-f",
      "x11grab",
      "-video_size",
      `${res.width}x${res.captureHeight}`,
      "-thread_queue_size",
      "1024",   // 1024 packets — ~34 s at 30 fps, generous without memory bloat
      "-framerate",
      "30",
      "-i",
      this.config.display,

      // === AUDIO INPUT ===
      "-f",
      "pulse",
      // 32768 packets of capture queue (~2x the previous 16384) doubles burst
      // absorption for x264 CPA load spikes without the memory(~2.6 MB ring array)
      // or starvation risk of 65536+nobuffer. Recording isn't latency-critical
      // (the low-latency sound-level pipe uses its own `-flush_packets 1`).
      // aresample=async=1000 (already in OUTPUT 2) softens any remaining xrun
      // discontinuities by stretching instead of hard-cutting, so the queue just
      // needs to reduce xrun frequency, not eliminate them.
      "-thread_queue_size",
      "32768",
      "-rtbufsize",
      "128k",
      "-i",
      VIRTUAL_SPEAKER_MONITOR,

      // === OUTPUT 1: RAW VIDEO (no audio) ===
      "-map",
      "0:v:0",
      "-c:v",
      "libx264",
      "-preset",
      // veryfast: ~40% less encoder CPU than "fast" at the same crf, with
      // near-identical visual quality on meeting content (mostly static
      // talking heads / shared screens). Output is ~10-15% larger, which is
      // cheap S3 vs compute: the encoder is the biggest steady CPU draw of
      // the bot, and lower per-bot CPU lets more bots share a node.
      "veryfast",
      "-crf",
      "23",
      "-profile:v",
      "main",
      "-level",
      "4.0",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "20", // Keyframe every 20 frames (1 sec at 20fps) for precise trimming
      "-keyint_min",
      "20", // Force minimum keyframe interval
      "-bf",
      "0",
      "-refs",
      "1",
      "-vf",
      `crop=${res.width}:${res.height}:0:140`,
      "-avoid_negative_ts",
      "make_zero",
      "-f",
      "mp4",
      "-y",
      rawVideoPath,

      // === OUTPUT 2: RAW AUDIO ===
      "-map",
      "1:a:0",
      "-vn",
      // Reconcile the audio sample-clock against the wall-clock-paced video
      // (x11grab dups/drops frames to hold 30fps) so long recordings don't desync.
      // async=1 caps soft compensation at ~1 sample/sec, so ANY drift beyond that
      // is corrected by HARD fill/trim (insert silence / drop samples) at every
      // timestamp discontinuity from PulseAudio xruns — each a click/glitch, which
      // shows up as the vertical-streak artefacts in the recording's spectrogram.
      // async=1000 lets it absorb drift by gently STRETCHING (up to ~1000 samples/
      // sec ≈ 21 ms/sec) instead of hard-cutting, removing the per-discontinuity
      // clicks while still holding A/V sync over long recordings.
      "-af",
      "aresample=async=1000:first_pts=0",
      "-sample_fmt",
      "s16",
      "-ac",
      "1",
      "-ar",
      AUDIO_SAMPLE_RATE.toString(),
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      this.rawAudioPath,

      // === OUTPUT 3: SCREENSHOTS (every 5 seconds) - fixed resolution ===
      "-map",
      "0:v:0",
      "-vf",
      `fps=${1 / SCREENSHOT_PERIOD},crop=${res.width}:${res.height}:0:140,scale=${SCREENSHOT_WIDTH}:${SCREENSHOT_HEIGHT}`,
      "-q:v",
      "3", // High quality JPEG compression
      "-f",
      "image2",
      "-y",
      screenshotPattern,

      // === OUTPUT 4: SOUND LEVEL MONITORING (stdout) ===
      // This output is CRITICAL for automatic leave detection
      // It feeds the SoundLevelMonitor which is independent of streaming
      "-map",
      "1:a:0",
      "-acodec",
      "pcm_f32le", // Float32 for easy processing
      "-ac",
      "1", // Mono
      "-ar",
      "24000", // 24kHz is sufficient for sound level analysis
      "-flush_packets",
      "1", // Flush each packet to the pipe immediately — keeps the sound level
      // (and the Zoom observer's isSpeaking) low-latency instead of buffering.
      "-f",
      "f32le", // Raw float32 format
      "pipe:1" // stdout
    )

    return args
  }

  private setupProcessMonitoring(): void {
    if (!this.ffmpegProcess) return

    // Remove any existing listeners to prevent duplicates
    this.ffmpegProcess.removeAllListeners("error")
    this.ffmpegProcess.removeAllListeners("exit")

    this.ffmpegProcess.on("error", (error) => {
      console.error("FFmpeg error:", formatError(error))
      this.emit("error", error)
    })

    this.ffmpegProcess.on("exit", async (code) => {
      console.log(`FFmpeg exited with code ${code}`)

      // Consider recording successful if:
      // - Exit code 0 (normal completion)
      // - Exit code 255 or 143 (SIGINT/SIGTERM) when we're in grace period (requested shutdown)
      const isSuccessful = code === 0 || (this.gracePeriodActive && (code === 255 || code === 143))

      if (isSuccessful) {
        console.log("✅ Recording considered successful, uploading...")
        try {
          await this.handleSuccessfulRecording()
        } catch (error) {
          console.error(
            "❌ Error in handleSuccessfulRecording:",
            error instanceof Error ? error.message : error
          )
          this.emit("error", error)
          return
        }
      } else {
        console.warn(`⚠️ Recording failed - unexpected exit code: ${code}`)
      }

      this.isRecording = false
      this.cleanupProcess()
      this.emit("stopped")
    })

    // Enhanced error monitoring for PulseAudio issues
    let errorCount = 0
    const maxErrors = 15 // Threshold for PulseAudio errors (buffer reduced to 4096 for latency)
    const errorWindowMs = 60000 // 60 seconds window
    let lastErrorTime = 0
    const errorCooldownMs = 10000 // 10 second cooldown - less aggressive
    let consecutiveErrors = 0
    const maxConsecutiveErrors = 10 // Much less aggressive

    // Remove any existing stderr listeners to prevent duplicates
    this.ffmpegProcess.stderr?.removeAllListeners("data")

    this.ffmpegProcess.stderr?.on("data", (data) => {
      const output = data.toString()
      const outputLower = output.toLowerCase()
      if (outputLower.includes("error")) {
        console.error("FFmpeg stderr:", output.trim())

        // Check for file write/I/O errors that indicate disk/filesystem issues
        if (
          outputLower.includes("error writing output file") ||
          outputLower.includes("i/o error") ||
          outputLower.includes("no space left on device") ||
          outputLower.includes("disk full") ||
          outputLower.includes("filesystem full") ||
          outputLower.includes("cannot write") ||
          outputLower.includes("write error") ||
          outputLower.includes("broken pipe") ||
          outputLower.includes("connection reset") ||
          outputLower.includes("connection refused")
        ) {
          const now = Date.now()
          const recordingDurationSeconds =
            this.recordingStartTime > 0 ? (now - this.recordingStartTime) / 1000 : 0

          // Log file size at time of error for diagnostics
          let currentFileSize = "unknown"
          try {
            if (this.rawAudioPath && fs.existsSync(this.rawAudioPath)) {
              const stats = fs.statSync(this.rawAudioPath)
              currentFileSize = `${(stats.size / (1024 * 1024)).toFixed(2)} MB (${stats.size} bytes)`
            }
          } catch (_e) {
            // Ignore file stat errors
          }

          console.error("❌ CRITICAL: FFmpeg file write error detected!")
          console.error(`   📊 Recording duration: ${recordingDurationSeconds.toFixed(1)}s`)
          console.error(`   📁 Raw audio file size: ${currentFileSize}`)
          console.error(`   🔍 Error details: ${output.trim()}`)

          // Log system resources for diagnostics
          void this.logSystemResources()

            // Emit a critical error event
            ; (this as EventEmitter).emit("error", {
              type: "fileWriteError",
              message: "FFmpeg file write error detected",
              error: output.trim(),
              recordingDuration: recordingDurationSeconds,
              currentFileSize,
              timestamp: now
            })
        }
        // Check for specific PulseAudio errors that indicate audio input failure
        else if (
          outputLower.includes("error during demuxing") ||
          outputLower.includes("error retrieving a packet from demuxer") ||
          outputLower.includes("generic error in an external library") ||
          outputLower.includes("connection lost") ||
          outputLower.includes("broken pipe")
        ) {
          const now = Date.now()
          errorCount++
          consecutiveErrors++

          // Enhanced error logging with context
          const memoryUsage = process.memoryUsage()
          const memoryMB = Math.round(memoryUsage.rss / 1024 / 1024)
          const uptime = Math.round((Date.now() - this.recordingStartTime) / 1000)

          console.warn(
            `⚠️ PulseAudio demuxing error detected (${errorCount}/${maxErrors}, consecutive: ${consecutiveErrors}/${maxConsecutiveErrors})`
          )
          console.warn(
            `   📊 Context: Memory=${memoryMB}MB, Uptime=${uptime}s, Process=${this.ffmpegProcess?.pid}`
          )
          console.warn(`   🔍 Error details: ${output.trim()}`)

          // Log system resource status
          void this.logSystemResources()

          // Only emit warning if enough errors accumulate
          if (errorCount >= maxErrors && now - lastErrorTime > errorCooldownMs) {
            lastErrorTime = now
            console.warn(
              "⚠️ Multiple PulseAudio errors detected, but continuing recording with larger buffers..."
            )

            // Emit a warning event for monitoring purposes
            const audioWarning: AudioWarningEvent = {
              type: "pulseAudioWarning",
              errorCount,
              message:
                "PulseAudio input stream experiencing issues - monitoring with increased buffers",
              timestamp: Date.now()
            }
            this.emit("audioWarning", audioWarning)
          }
        } else {
          // Reset consecutive error count on non-PulseAudio errors
          consecutiveErrors = Math.max(0, consecutiveErrors - 1)
        }
      } else {
        // Reset consecutive error count on successful output
        consecutiveErrors = Math.max(0, consecutiveErrors - 1)
      }
    })

    // Clear any existing error monitor interval to prevent duplicates
    if (this.errorMonitorIntervalId) {
      clearInterval(this.errorMonitorIntervalId)
      this.errorMonitorIntervalId = null
    }

    // Reset error count periodically but less frequently
    this.errorMonitorIntervalId = setInterval(() => {
      if (errorCount > 0) {
        console.log(`🔄 Resetting PulseAudio error count (was ${errorCount})`)
        errorCount = 0
        lastErrorTime = 0
        consecutiveErrors = 0
      }
    }, errorWindowMs)
  }

  /**
   * Setup sound level monitoring from FFmpeg stdout
   * This is CRITICAL for automatic leave detection (silence timeout, noone_joined_timeout)
   * Completely independent of streaming functionality
   */
  private setupSoundLevelMonitoring(): void {
    if (!this.ffmpegProcess) return

    const monitor = SoundLevelMonitor.getInstance()
    monitor.start()

    try {
      // Remove any existing listeners to prevent duplicates
      this.ffmpegProcess.stdout?.removeAllListeners("data")

      this.ffmpegProcess.stdout?.on("data", (data: Buffer) => {
        try {
          // Handle chunk boundaries: Float32 frames can split across data events
          // Concatenate with any remainder from previous chunk
          let buf: Buffer
          if (this.soundMonitorRemainder.length > 0) {
            buf = Buffer.concat([this.soundMonitorRemainder, data])
          } else {
            buf = data
          }

          // Only process aligned bytes (divisible by 4 for Float32)
          const alignedLen = buf.length - (buf.length % 4)
          if (alignedLen === 0) {
            // Not enough data yet, save for next chunk
            this.soundMonitorRemainder = buf
            return
          }

          // Save unaligned remainder for next chunk
          this.soundMonitorRemainder = buf.subarray(alignedLen) as Buffer

          // Create Float32Array view and copy to avoid retaining pooled buffers
          const view = new Float32Array(buf.buffer, buf.byteOffset, alignedLen / 4)
          const float32Array = new Float32Array(view) // Copy to standalone array

          // Feed to sound level monitor (always active, critical for automatic leave)
          monitor.processAudioChunk(float32Array)
        } catch (error) {
          console.error("[SoundLevelMonitor] Failed to process audio chunk:", formatError(error))
          // Don't throw - continue processing other chunks
        }
      })

      console.log("✅ Sound level monitoring enabled (FFmpeg stdout → automatic leave detection)")
    } catch (error) {
      console.error("[SoundLevelMonitor] Failed to setup monitoring:", formatError(error))
    }
  }

  private setupFileSizeMonitoring(): void {
    if (!this.rawAudioPath) return

    // Clear any existing interval to prevent duplicates
    if (this.fileSizeMonitorIntervalId) {
      clearInterval(this.fileSizeMonitorIntervalId)
      this.fileSizeMonitorIntervalId = null
    }

    let lastFileSize = 0
    let lastCheckTime = Date.now()
    let consecutiveNoGrowthCount = 0
    const FILE_SIZE_CHECK_INTERVAL = 30000 // 30 seconds
    const MAX_CONSECUTIVE_NO_GROWTH = 3 // Warn after 3 consecutive checks with no growth (90 seconds)

    this.fileSizeMonitorIntervalId = setInterval(() => {
      try {
        if (!fs.existsSync(this.rawAudioPath)) {
          // File doesn't exist yet, skip this check
          return
        }

        const stats = fs.statSync(this.rawAudioPath)
        const currentSize = stats.size
        const currentTime = Date.now()
        const recordingDurationSeconds = (currentTime - this.recordingStartTime) / 1000
        const sizeMB = (currentSize / (1024 * 1024)).toFixed(2)

        // Check if file size has grown since last check
        const hasGrown = currentSize > lastFileSize
        const timeSinceLastCheck = (currentTime - lastCheckTime) / 1000

        if (hasGrown) {
          consecutiveNoGrowthCount = 0
          const growthBytes = currentSize - lastFileSize
          const growthMB = (growthBytes / (1024 * 1024)).toFixed(2)
          const growthRate = growthBytes / timeSinceLastCheck // bytes per second
          const growthRateMBps = (growthRate / (1024 * 1024)).toFixed(2)

          console.log(
            `📊 Raw audio file size: ${sizeMB} MB (${currentSize} bytes) | Recording: ${recordingDurationSeconds.toFixed(1)}s | Growth: +${growthMB} MB in ${timeSinceLastCheck.toFixed(1)}s (${growthRateMBps} MB/s)`
          )
        } else {
          consecutiveNoGrowthCount++
          if (consecutiveNoGrowthCount >= MAX_CONSECUTIVE_NO_GROWTH) {
            console.warn(
              `⚠️ WARNING: Raw audio file has not grown for ${consecutiveNoGrowthCount * (FILE_SIZE_CHECK_INTERVAL / 1000)}s! Current: ${sizeMB} MB (${currentSize} bytes) | Recording: ${recordingDurationSeconds.toFixed(1)}s. This may indicate a silent write failure.`
            )
            // Dead audio means the browser's stream isn't reaching the monitored
            // sink (virtual_speaker.monitor). Capture the PulseAudio routing state so
            // we can confirm the failure mode from prod logs (which sink the browser
            // is on vs the server default) rather than guessing at a fix.
            void this.logAudioPipelineDiagnostics(recordingDurationSeconds)
          } else {
            console.log(
              `📊 Raw audio file size: ${sizeMB} MB (${currentSize} bytes) | Recording: ${recordingDurationSeconds.toFixed(1)}s | No growth detected (${consecutiveNoGrowthCount}/${MAX_CONSECUTIVE_NO_GROWTH})`
            )
          }
        }

        lastFileSize = currentSize
        lastCheckTime = currentTime
      } catch (error) {
        // Don't log errors for missing files during early recording
        if (fs.existsSync(this.rawAudioPath)) {
          console.warn(`⚠️ Error checking raw audio file size: ${error}`)
        }
      }
    }, FILE_SIZE_CHECK_INTERVAL)
  }

  /**
   * Log the PulseAudio routing state when the raw audio file stops growing.
   *
   * FFmpeg records from the monitored sink (`VIRTUAL_SPEAKER_MONITOR`). If that file
   * never grows the recording is silent — the browser's audio isn't reaching the
   * monitored sink. Rather than blindly re-routing (which risks masking the real
   * cause), capture the actual state so the failure mode is confirmable from prod
   * logs: the server default sink, every sink, and which sink each browser stream is
   * on (plus corked/mute). Diagnostic-only, throttled, best-effort — never throws.
   */
  private async logAudioPipelineDiagnostics(recordingDurationSeconds: number): Promise<void> {
    const now = Date.now()
    // Throttle: at most one dump per file-size check window (30s).
    if (now - this.lastAudioDiagAt < 30_000) {
      return
    }
    this.lastAudioDiagAt = now
    this.audioDiagCount++

    try {
      // Use async exec (not execSync) so the three pactl spawns don't block
      // the Node event loop. While blocked, FFmpeg's stdout pipe fills, which
      // back-pressures FFmpeg's audio thread and produces xruns/clicks.
      const { stdout: defaultSinkOut } = await execAsync("pactl info", { timeout: 5000 })
      const defaultSink =
        defaultSinkOut
          .split("\n")
          .find((l) => l.startsWith("Default Sink:"))
          ?.trim() ?? "Default Sink: <unknown>"

      const { stdout: sinksOut } = await execAsync("pactl list sinks short", { timeout: 5000 })
      const sinks = sinksOut.trim().replace(/\n/g, " ; ")

      // Keep only routing-relevant fields from the sink-input dump.
      const { stdout: routingOut } = await execAsync("pactl list sink-inputs", { timeout: 5000 })
      const routing = routingOut
        .split("\n")
        .map((l) => l.trim())
        .filter((l) =>
          /^Sink Input #|^Sink:|application\.name|application\.process\.binary|media\.name|Corked:|Mute:/.test(
            l
          )
        )
        .join(" | ")

      console.warn(
        `🔎 [audio-diag #${this.audioDiagCount}] raw audio not growing at ${recordingDurationSeconds.toFixed(0)}s — expected sink '${VIRTUAL_SPEAKER}'. ${defaultSink}. sinks=[${sinks}]. sink-inputs: ${routing || "<none>"}`
      )
    } catch (error) {
      console.warn(`⚠️ [audio-diag] Failed to collect PulseAudio state: ${formatError(error)}`)
    }
  }

  private async uploadAudioChunks(chunksDir: string, botUuid: string): Promise<void> {
    if (!S3Uploader.getInstance()) return

    try {
      const files = fs.readdirSync(chunksDir)
      const chunkFiles = files.filter(
        (file) => file.startsWith(`${botUuid}-`) && file.endsWith(".flac")
      )

      console.log(`📤 Uploading ${chunkFiles.length} audio chunks...`)

      for (const filename of chunkFiles) {
        const chunkPath = path.join(chunksDir, filename)

        if (!fs.existsSync(chunkPath)) {
          console.warn(`Chunk file not found: ${chunkPath}`)
          GLOBAL.addAudioChunk({
            s3Key: null,
            filePath: chunkPath,
            extension: "flac",
            uploaded: false,
            uploadedAt: null,
            type: "audio",
            errorCode: "FILE_NOT_FOUND",
            errorMessage: `Chunk file not found: ${chunkPath}`
          })
          continue
        }

        try {
          const stats = fs.statSync(chunkPath)
          if (stats.size === 0) {
            console.warn(`Chunk file is empty: ${filename}`)
            GLOBAL.addAudioChunk({
              s3Key: null,
              filePath: chunkPath,
              extension: "flac",
              uploaded: false,
              uploadedAt: null,
              type: "audio",
              errorCode: "FILE_TOO_SMALL",
              errorMessage: `Chunk file is empty: ${chunkPath}. Size: ${stats.size} bytes`
            })
            continue
          }
          if (stats.size < MIN_AUDIO_CHUNK_SIZE) {
            console.warn(`Chunk file is too small: ${filename}`)
            GLOBAL.addAudioChunk({
              s3Key: null,
              filePath: chunkPath,
              extension: "flac",
              uploaded: false,
              uploadedAt: null,
              type: "audio",
              errorCode: "FILE_TOO_SMALL",
              errorMessage: `Chunk file is too small: ${chunkPath}. Size: ${stats.size} bytes`
            })
            continue
          }

          const s3Key = `${botUuid}/${filename}`
          console.log(`📤 Uploading chunk: ${filename} (${stats.size} bytes)`)

          await S3Uploader.getInstance().uploadFile(
            chunkPath,
            envVars.AWS_S3_AUDIO_CHUNKS_BUCKET,
            s3Key
          )
          GLOBAL.addAudioChunk({
            s3Key,
            filePath: chunkPath,
            extension: "flac",
            uploaded: true,
            uploadedAt: new Date().toISOString(),
            type: "audio",
            errorCode: null,
            errorMessage: null
          })

          console.log(`✅ Chunk uploaded: ${filename}`)
        } catch (error) {
          console.error(`Failed to upload chunk ${filename}:`, formatError(error))
          GLOBAL.addAudioChunk({
            s3Key: null,
            filePath: chunkPath,
            extension: "flac",
            uploaded: false,
            uploadedAt: null,
            type: "audio",
            errorCode: "UPLOAD_FAILED",
            errorMessage: error instanceof Error ? error.message : JSON.stringify(error)
          })
        }
      }
    } catch (error) {
      console.error("Failed to read chunks directory:", error)
    }
  }

  private removeUploadedFile(filePath: string): void {
    try {
      fs.unlinkSync(filePath)
    } catch (error) {
      // Upload already succeeded and its manifest entry is authoritative. Local
      // cleanup failure must not append a conflicting UPLOAD_FAILED entry.
      console.warn(`Failed to remove uploaded local file ${filePath}:`, formatError(error))
    }
  }

  public async uploadToS3(): Promise<void> {
    if (this.filesUploaded || !S3Uploader.getInstance()) {
      return
    }

    const identifier = PathManager.getInstance().getIdentifier()

    try {
      if (fs.existsSync(this.audioOutputPath)) {
        const stats = fs.statSync(this.audioOutputPath)
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2)
        const sizeBytes = stats.size
        const recordingDurationSeconds =
          this.recordingStartTime > 0 ? (Date.now() - this.recordingStartTime) / 1000 : 0

        console.log(
          `📤 Uploading FLAC audio to artifacts bucket: ${envVars.AWS_S3_ARTIFACTS_BUCKET}`
        )
        console.log(
          `📊 Audio file size before upload: ${sizeMB} MB (${sizeBytes} bytes) | Recording duration: ${recordingDurationSeconds.toFixed(1)}s`
        )

        const s3Key = `${identifier}/output.flac`
        await S3Uploader.getInstance().uploadFile(
          this.audioOutputPath,
          envVars.AWS_S3_ARTIFACTS_BUCKET,
          s3Key
        )
        GLOBAL.addArtifactKey({
          s3Key,
          filePath: this.audioOutputPath,
          extension: "flac",
          uploaded: true,
          uploadedAt: new Date().toISOString(),
          type: "audio",
          errorCode: null,
          errorMessage: null
        })
        this.removeUploadedFile(this.audioOutputPath)
      } else {
        GLOBAL.addArtifactKey({
          s3Key: null,
          filePath: this.audioOutputPath,
          extension: "flac",
          uploaded: false,
          uploadedAt: null,
          type: "audio",
          errorCode: "FILE_NOT_FOUND",
          errorMessage: `Audio file not found: ${this.audioOutputPath}`
        })
      }
    } catch (error) {
      console.error("Failed to upload audio file:", formatError(error))
      GLOBAL.addArtifactKey({
        s3Key: null,
        filePath: this.audioOutputPath,
        extension: "flac",
        uploaded: false,
        uploadedAt: null,
        type: "audio",
        errorCode: "UPLOAD_FAILED",
        errorMessage: error instanceof Error ? error.message : JSON.stringify(error)
      })
      // Don't throw - continue with video upload
    }

    // Only upload video if not in audio-only mode
    if (GLOBAL.get().recording_mode !== "audio_only") {
      try {
        if (fs.existsSync(this.outputPath)) {
          const stats = fs.statSync(this.outputPath)
          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2)
          const sizeBytes = stats.size

          console.log(`📤 Uploading MP4 to artifacts bucket: ${envVars.AWS_S3_ARTIFACTS_BUCKET}`)
          console.log(`📊 Video file size before upload: ${sizeMB} MB (${sizeBytes} bytes)`)
          const s3Key = `${identifier}/output.mp4`
          await S3Uploader.getInstance().uploadFile(
            this.outputPath,
            envVars.AWS_S3_ARTIFACTS_BUCKET,
            s3Key
          )
          GLOBAL.addArtifactKey({
            s3Key,
            filePath: this.outputPath,
            extension: "mp4",
            uploaded: true,
            uploadedAt: new Date().toISOString(),
            type: "video",
            errorCode: null,
            errorMessage: null
          })
          this.removeUploadedFile(this.outputPath)
        } else {
          const recordingMode = GLOBAL.get().recording_mode
          GLOBAL.addArtifactKey({
            s3Key: null,
            filePath: this.outputPath,
            extension: "mp4",
            uploaded: false,
            uploadedAt: null,
            type: "video",
            errorCode: "FILE_NOT_FOUND",
            errorMessage: `Video file not found. Recording mode: ${recordingMode}. Output path: ${this.outputPath}`
          })
        }
      } catch (error) {
        console.error("Failed to upload video file:", formatError(error))
        GLOBAL.addArtifactKey({
          s3Key: null,
          filePath: this.outputPath,
          extension: "mp4",
          uploaded: false,
          uploadedAt: null,
          type: "video",
          errorCode: "UPLOAD_FAILED",
          errorMessage: error instanceof Error ? error.message : JSON.stringify(error)
        })
        // Don't throw - mark as uploaded to allow process completion
      }
    } else {
      // Audio-only mode: skip video upload, just clean up if it exists
      if (fs.existsSync(this.outputPath)) {
        try {
          fs.unlinkSync(this.outputPath)
          console.log("🗑️ Skipped video upload (audio-only mode), cleaned up video file")
        } catch (error) {
          console.warn("Failed to clean up video file:", formatError(error))
        }
      }
    }

    // Adjust diarization timestamps for pause windows (if any)
    const diarizationPath = `${PathManager.getInstance().getTempPath()}/diarization.jsonl`
    const pauseContext = MeetingStateMachine.instance?.getContext()
    if (pauseContext && pauseContext.pauseWindows.length > 0 && fs.existsSync(diarizationPath)) {
      this.adjustDiarizationForPauseWindows(
        diarizationPath,
        pauseContext.pauseWindows,
        this.meetingStartTime
      )
    }

    // Upload diarization file
    try {
      if (fs.existsSync(diarizationPath)) {
        const stats = fs.statSync(diarizationPath)
        if (stats.size === 0) {
          console.warn(`Diarization file is empty: ${diarizationPath}`)
          GLOBAL.addArtifactKey({
            s3Key: null,
            filePath: diarizationPath,
            extension: "jsonl",
            uploaded: false,
            uploadedAt: null,
            type: "diarization",
            errorCode: "FILE_TOO_SMALL",
            errorMessage: `Diarization file is empty: ${diarizationPath}. Size: ${stats.size} bytes`
          })
        } else {
          console.log(`Uploading diarization file to S3: ${envVars.AWS_S3_ARTIFACTS_BUCKET}`)
          const s3Key = `${identifier}/diarization.jsonl`
          await S3Uploader.getInstance().uploadFile(
            diarizationPath,
            envVars.AWS_S3_ARTIFACTS_BUCKET,
            s3Key
          )
          GLOBAL.addArtifactKey({
            s3Key,
            filePath: diarizationPath,
            extension: "jsonl",
            uploaded: true,
            uploadedAt: new Date().toISOString(),
            type: "diarization",
            errorCode: null,
            errorMessage: null
          })
          this.removeUploadedFile(diarizationPath)
          console.log("Diarization file uploaded successfully")
        }
      } else {
        GLOBAL.addArtifactKey({
          s3Key: null,
          filePath: diarizationPath,
          extension: "jsonl",
          uploaded: false,
          uploadedAt: null,
          type: "diarization",
          errorCode: "FILE_NOT_FOUND",
          errorMessage: `Diarization file not found: ${diarizationPath}`
        })
      }
    } catch (error) {
      console.error("Failed to upload diarization file:", formatError(error))
      GLOBAL.addArtifactKey({
        s3Key: null,
        filePath: diarizationPath,
        extension: "jsonl",
        uploaded: false,
        uploadedAt: null,
        type: "diarization",
        errorCode: "UPLOAD_FAILED",
        errorMessage: error instanceof Error ? error.message : JSON.stringify(error)
      })
      // Don't throw - continue with completion
    }

    this.filesUploaded = true
    // Every expected artifact now has a manifest entry, including failed
    // uploads copied to EFS. Crash recovery may safely submit this payload:
    // the api-server can either continue or defer it for reconciliation.
    GLOBAL.markEndMeetingPayloadReady()
  }

  public async stopRecording(): Promise<void> {
    if (!this.isRecording || !this.ffmpegProcess) {
      return
    }

    // Capture exit time right when recording stops (before grace period and processing)
    const exitTime = Math.floor(Date.now() / 1000)
    console.log(`Bot exit time captured as ${exitTime}`)
    GLOBAL.setExitTime(exitTime)

    console.log("🛑 Stop recording requested - starting grace period...")
    this.gracePeriodActive = true

    const gracePeriodMs = GRACE_PERIOD_SECONDS * 1000

    // Wait for grace period to allow clean ending
    console.log(`⏳ Grace period: ${GRACE_PERIOD_SECONDS}s for clean ending`)

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        console.log("✅ Grace period completed - stopping FFmpeg cleanly")
        resolve()
      }, gracePeriodMs)
    })

    return new Promise((resolve, reject) => {
      // Wait for the 'stopped' event instead of 'exit' to ensure upload is complete
      this.once("stopped", () => {
        this.gracePeriodActive = false
        this.cleanupProcess()
        resolve()
      })

      this.once("error", (error) => {
        console.error(
          "ScreenRecorder error during stop:",
          error instanceof Error ? error.message : error
        )
        this.gracePeriodActive = false
        this.cleanupProcess()
        reject(error)
      })

      // Send graceful termination signal
      this.ffmpegProcess!.kill("SIGINT")

      // Fallback force kill after timeout
      this.forceKillTimeoutId = setTimeout(() => {
        if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
          console.warn("⚠️ Force killing FFmpeg process")
          this.ffmpegProcess.kill("SIGKILL")
        }
        this.forceKillTimeoutId = null
      }, 8000)
    })
  }

  private cleanupProcess(): void {
    // Log memory usage before cleanup
    this.logMemoryUsage("Before cleanup")

    // Clear error monitor interval to prevent memory leaks
    if (this.errorMonitorIntervalId) {
      clearInterval(this.errorMonitorIntervalId)
      this.errorMonitorIntervalId = null
    }

    // Clear file size monitor interval to prevent memory leaks
    if (this.fileSizeMonitorIntervalId) {
      clearInterval(this.fileSizeMonitorIntervalId)
      this.fileSizeMonitorIntervalId = null
    }

    // Clear force kill timeout to prevent memory leaks
    if (this.forceKillTimeoutId) {
      clearTimeout(this.forceKillTimeoutId)
      this.forceKillTimeoutId = null
    }

    // Remove all event listeners from stdout/stderr and process to prevent memory leaks
    if (this.ffmpegProcess) {
      // Remove listeners from stdout if it exists
      if (this.ffmpegProcess.stdout) {
        this.ffmpegProcess.stdout.removeAllListeners()
      }
      // Remove listeners from stderr if it exists
      if (this.ffmpegProcess.stderr) {
        this.ffmpegProcess.stderr.removeAllListeners()
      }
      // Remove all listeners from the process itself
      this.ffmpegProcess.removeAllListeners()
      this.ffmpegProcess = null
    }

    // Log memory usage after cleanup
    this.logMemoryUsage("After cleanup")
  }

  private logMemoryUsage(context: string): void {
    const usage = process.memoryUsage()
    console.log(
      `💾 Memory usage ${context}: RSS=${Math.round(usage.rss / 1024 / 1024)}MB, Heap=${Math.round(usage.heapUsed / 1024 / 1024)}MB`
    )
  }

  private logSystemResourcesRunning = false

  private async logSystemResources(): Promise<void> {
    if (this.logSystemResourcesRunning) return
    this.logSystemResourcesRunning = true
    try {
      // Log FFmpeg process count (async so a slow lookup doesn't block
      // the stderr handler and stall FFmpeg output draining).
      const { stdout: ffOut } = await execAsync("pgrep -c ffmpeg || echo 0", {
        timeout: 3000
      })
      const { stdout: pulseOut } = await execAsync("pgrep -c pulseaudio || echo 0", {
        timeout: 3000
      })

      console.warn(
        `   🔍 System status: FFmpeg processes=${ffOut.trim()}, PulseAudio processes=${pulseOut.trim()}`
      )

      // Log file descriptor count if available (best-effort).
      try {
        const { stdout: fdOut } = await execAsync(
          `lsof -p ${process.pid} | wc -l`,
          { timeout: 3000 }
        )
        console.warn(`   📁 File descriptors: ${fdOut.trim()}`)
      } catch (_e) {
        // lsof not available
      }
    } catch (error) {
      console.warn(`   ⚠️ Could not gather system resource info: ${error}`)
    } finally {
      this.logSystemResourcesRunning = false
    }
  }

  public isCurrentlyRecording(): boolean {
    return this.isRecording
  }

  public getStatus(): {
    isRecording: boolean
    gracePeriodActive: boolean
    recordingDurationMs: number
  } {
    return {
      isRecording: this.isRecording,
      gracePeriodActive: this.gracePeriodActive,
      recordingDurationMs: this.recordingStartTime > 0 ? Date.now() - this.recordingStartTime : 0
    }
  }

  private async handleSuccessfulRecording(): Promise<void> {
    console.log("Native recording completed")

    try {
      // Sync and merge separate audio/video files
      await this.syncAndMergeFiles()

      // The merged output now exists on disk. Record the finalize marker
      // IMMEDIATELY — before the upload / S3Uploader-availability guard — so the
      // merged-output-exists invariant holds regardless of whether upload runs.
      // From here a crash/eviction must NOT requeue (that would re-record); the
      // S3Uploader EFS-fallback + reconciliation job salvage any upload failure.
      GLOBAL.markRecordingFinalized()

      // Auto-upload if not serverless and wait for completion
      if (!GLOBAL.isServerless()) {
        try {
          await this.uploadToS3()
          console.log("✅ Upload completed successfully")
        } catch (error) {
          console.error("❌ Upload failed:", formatError(error))
        }
      }
    } catch (error) {
      console.error("❌ Error during recording processing:", formatError(error))

      if (error instanceof Error) {
        if (error.message.includes("FFprobe failed") || error.message.includes("FFmpeg failed")) {
          // Preserve any terminal end_reason already set by the state machine
          // (TimeoutWaitingToStart, BotNotAccepted, LoginRequired, ApiRequest,
          // InvalidMeetingUrl, ExitingMeetingBeforeRecord, etc). Recording
          // post-processing failures shouldn't clobber the real cause of the
          // failure that the state machine already identified.
          if (GLOBAL.hasError()) {
            console.log(
              `Preserving existing end_reason ${GLOBAL.getEndReason()} instead of creating BotRemovedTooEarly`
            )
            throw error
          }

          console.log("Converting FFprobe/FFmpeg error to BotRemovedTooEarly")
          GLOBAL.setError(MeetingEndReason.BotRemovedTooEarly)
          throw new Error("Bot removed too early")
        }
      }

      // Re-throw the error so it propagates to the caller
      throw error
    }
  }

  private async syncAndMergeFiles(): Promise<void> {
    // Use the same sync and merge flow for both audio-only and video modes
    // Audio-only mode will just skip video upload at the end
    const tempDir = PathManager.getInstance().getTempPath()
    const rawVideoPath = path.join(tempDir, "raw.mp4")
    const rawAudioPath = path.join(tempDir, "raw.flac")

    console.log("🔄 Starting efficient sync and merge for long recording...")

    // 0. Log raw audio file size before processing
    if (fs.existsSync(rawAudioPath)) {
      const stats = fs.statSync(rawAudioPath)
      const fileSizeBytes = stats.size
      const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2)
      const recordingDurationSeconds =
        this.recordingStartTime > 0 ? (Date.now() - this.recordingStartTime) / 1000 : 0

      console.log(
        `📊 Raw audio file size: ${fileSizeMB} MB (${fileSizeBytes} bytes) | Recording duration: ${recordingDurationSeconds.toFixed(1)}s`
      )
    } else {
      console.warn("⚠️ Raw audio file not found:", rawAudioPath)
    }

    // 1. Calculate A/V stream offset using the exact timestamp of the sync signal.
    //    syncSignalTimestamp is set in startRecording() just before generateSyncSignal fires,
    //    so this is exact — no guesswork about when it happened.
    const expectedSyncSec = this.syncSignalTimestamp > 0
      ? (this.syncSignalTimestamp - this.recordingStartTime) / 1000
      : FLASH_SCREEN_SLEEP_TIME / 1000 // fallback: should never happen in normal operation
    // Per-signal anchors: both signals ride the page.evaluate queue and can
    // fire seconds after syncSignalTimestamp under load. Anchoring each
    // detection window on its own real emission time — and subtracting the
    // emission gap in the offset math — isolates pure capture-start skew.
    const expectedAudioSyncSec = this.audioBeepWallMs > 0
      ? (this.audioBeepWallMs - this.recordingStartTime) / 1000
      : expectedSyncSec
    const expectedVideoSyncSec = this.videoFlashWallMs > 0
      ? (this.videoFlashWallMs - this.recordingStartTime) / 1000
      : expectedSyncSec
    console.log(
      `🎯 Sync signal fired at ${expectedSyncSec.toFixed(3)}s into recording (beep started ${expectedAudioSyncSec.toFixed(3)}s, flash painted ${expectedVideoSyncSec.toFixed(3)}s)`
    )

    const syncResult = await calculateVideoOffset(
      rawAudioPath,
      rawVideoPath,
      expectedAudioSyncSec,
      expectedVideoSyncSec
    )
    console.log(`🎯 Calculated A/V stream offset: ${syncResult.offsetSeconds.toFixed(3)}s`)
    if (syncResult.confidence < 0.9) {
      // Alertable marker: sync-signal detection failed (fully or partially), so the
      // A/V offset and capture-startup corrections below run degraded. Grep-able as
      // SYNC_CONFIDENCE_LOW in bot logs.
      console.warn(
        `⚠️ SYNC_CONFIDENCE_LOW confidence=${syncResult.confidence.toFixed(2)} ` +
        `audioTs=${syncResult.audioTimestamp.toFixed(3)} videoTs=${syncResult.videoTimestamp.toFixed(3)} ` +
        `expected=${expectedSyncSec.toFixed(3)} — proceeding without measured correction`
      )
    }
    const hasMeetingStartTime = this.meetingStartTime > 0

    // 2. Check if meetingStartTime is properly set - if not, bot was not accepted
    if (!hasMeetingStartTime) {
      console.error(`❌ Bot not accepted - meetingStartTime not set (${this.meetingStartTime})`)
      console.error("📊 Timing debug:")
      console.error(`   recordingStartTime: ${this.recordingStartTime}`)
      console.error(`   meetingStartTime: ${this.meetingStartTime}`)
      console.error(`   Current time: ${Date.now()}`)
      console.error(`   Recording duration: ${Date.now() - this.recordingStartTime}ms`)

      // Fallback: if we have a reasonable recording duration (>10s), set meetingStartTime to 5s before bot removal
      const recordingDuration = Date.now() - this.recordingStartTime
      if (recordingDuration > 10000) {
        // 10 seconds minimum
        console.warn(
          "⚠️ Setting meetingStartTime to 5s before bot removal to avoid showing pre-meeting phase"
        )
        this.meetingStartTime = Date.now() - 5000 // Show only last 5 seconds
      } else {
        GLOBAL.setError(MeetingEndReason.BotNotAccepted)
        throw new Error("Bot not accepted into meeting")
      }
    }

    // 3. Calculate where in the raw recording the meeting content starts.
    //    This is purely timestamp arithmetic — no heuristic needed.
    //    For authenticated bots, meetingStartTime can be < recordingStartTime (the bot
    //    joins before FFmpeg finishes initialising); clamp to 0 in that case.
    //
    //    (meetingStartTime - recordingStartTime) is wall-clock arithmetic, but the trim
    //    offset is applied in MEDIA time. FFmpeg needs time after spawn() to open
    //    x11grab and capture its first frame, so media t=0 corresponds to
    //    recordingStartTime + startupDelay, not recordingStartTime. Without correcting
    //    for that, the whole video (and the diarization timeline, which counts from
    //    meetingStartTime) leads the media by the startup delay for the entire meeting.
    //    The flash measurement gives us that delay directly: videoCaptureDelaySec is
    //    the flash's PAINT wall time minus its detected media time, so evaluate-queue
    //    delay no longer masquerades as (or cancels out) capture delay, and the value
    //    is valid even when only the flash was detected. It is 0 when the flash was
    //    not detected at all.
    const measuredStartupDelaySec = syncResult.videoCaptureDelaySec
    // x11grab startup can't be negative and is typically 0.1–0.5s; clamp against
    // detection outliers (VIDEO_SYNC_WINDOW_BACK_SEC allows matches up to 2s early).
    const startupDelaySec = Math.min(Math.max(measuredStartupDelaySec, 0), 2.0)
    if (measuredStartupDelaySec !== startupDelaySec) {
      console.warn(
        `⚠️ Measured capture startup delay ${measuredStartupDelaySec.toFixed(3)}s outside [0, 2.0]s — clamped to ${startupDelaySec.toFixed(3)}s`
      )
    }
    const rawCalcOffsetVideo =
      (this.meetingStartTime - this.recordingStartTime) / 1000 - startupDelaySec
    const calcOffsetVideo = Math.max(0, rawCalcOffsetVideo)

    console.log("📊 Debug values:")
    console.log(`   syncResult.videoTimestamp: ${syncResult.videoTimestamp}s`)
    console.log(`   syncResult.audioTimestamp: ${syncResult.audioTimestamp}s`)
    console.log(`   expectedSyncSec: ${expectedSyncSec.toFixed(3)}s`)
    console.log(`   meetingStartTime: ${this.meetingStartTime}`)
    console.log(`   recordingStartTime: ${this.recordingStartTime}`)
    console.log(`   capture startup delay: ${startupDelaySec.toFixed(3)}s`)
    console.log(`   calcOffsetVideo (raw): ${rawCalcOffsetVideo.toFixed(3)}s → clamped: ${calcOffsetVideo.toFixed(3)}s`)
    if (rawCalcOffsetVideo < 0) {
      console.warn(
        `⚠️ Meeting start precedes media t=0 by ${(-rawCalcOffsetVideo).toFixed(3)}s (authenticated bot fast-join and/or capture startup delay). Trimming from t=0.`
      )
    }

    // 4. Calculate audio padding needed (can be negative for trimming)
    const audioPadding = syncResult.videoTimestamp - syncResult.audioTimestamp

    console.log(`🔇 Audio padding needed: ${audioPadding.toFixed(3)}s`)

    // 5. Prepare audio with padding or trimming if needed
    const processedAudioPath = path.join(tempDir, "processed.flac")
    if (audioPadding > 0) {
      console.log(`🔇 Adding ${audioPadding.toFixed(3)}s silence to audio start (video ahead)...`)
      await this.addSilencePadding(rawAudioPath, processedAudioPath, audioPadding)
    } else if (audioPadding < 0) {
      console.log(
        `✂️ Trimming ${(audioPadding * -1).toFixed(3)}s from audio start (video behind)...`
      )
      await this.trimAudioStart(rawAudioPath, processedAudioPath, audioPadding * -1)
    } else {
      // No padding or trimming needed, just copy
      fs.copyFileSync(rawAudioPath, processedAudioPath)
    }

    // 6. Merge video and audio (both files are now synchronized from start)
    const mergedPath = path.join(tempDir, "merged.mp4")
    await this.mergeWithSync(rawVideoPath, processedAudioPath, mergedPath)

    const videoDuration = await this.getDuration(rawVideoPath)
    const audioDuration = await this.getDuration(processedAudioPath)
    const finalDuration = Math.min(videoDuration - calcOffsetVideo, audioDuration)

    console.log(`📊 Final duration: ${finalDuration.toFixed(2)}s`)
    await this.finalTrimFromOffset(mergedPath, this.outputPath, calcOffsetVideo, finalDuration)

    // 6.5. Trim pause windows (if any)
    const context = MeetingStateMachine.instance?.getContext()
    if (context && context.pauseWindows.length > 0) {
      // Snap pause timestamps to keyframe boundaries so the video trim cuts
      // exactly match the diarization adjustment. Without this, the ±1s
      // keyframe snapping inside FFmpeg drifts the speaker labels out of
      // sync with the video content. Mutating context.pauseWindows makes
      // the later diarization adjustment use the same snapped values.
      context.pauseWindows = await this.snapPauseWindowsToKeyframes(
        this.outputPath,
        context.pauseWindows,
        this.meetingStartTime
      )
      await this.trimPauseWindows(this.outputPath, context.pauseWindows, this.meetingStartTime)
    }

    // 7. Upload raw video for debugging (if enabled)
    if (UPLOAD_RAW_VIDEO && fs.existsSync(rawVideoPath) && S3Uploader.getInstance()) {
      try {
        const identifier = PathManager.getInstance().getIdentifier()
        const stats = fs.statSync(rawVideoPath)
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2)
        const sizeBytes = stats.size

        console.log("📤 Uploading raw video to logs bucket for debugging...")
        console.log(`📊 Raw video file size: ${sizeMB} MB (${sizeBytes} bytes)`)

        const s3Key = `${identifier}/raw_video.mp4`
        await S3Uploader.getInstance()!.uploadFile(
          rawVideoPath,
          envVars.AWS_S3_LOGS_BUCKET,
          s3Key,
          { raw_upload: "true" }
        )

        console.log(`✅ Raw video uploaded to logs bucket: ${s3Key} (tagged with raw_upload=true)`)
      } catch (error) {
        console.warn("⚠️ Failed to upload raw video for debugging:", formatError(error))
        // Don't throw - continue with processing
      }
    }

    // 8. Extract audio from the final trimmed video (ensures perfect sync)
    try {
      await this.extractAudioFromVideo(this.outputPath, this.audioOutputPath)
      console.log(`✅ Audio extracted from final video: ${this.audioOutputPath}`)

      // 9. Create audio chunks from the extracted audio
      await this.createAudioChunks(this.audioOutputPath)
    } catch (error) {
      console.warn(`⚠️ Audio extraction failed (likely due to bot removal): ${error}`)
      if (GLOBAL.get().recording_mode === "audio_only") {
        // Audio-only mode with no extractable audio = nothing to deliver.
        // Mark the failure here so the bot emits recording_failed instead
        // of reporting silent success with an empty manifest — don't rely
        // on handleSuccessfulRecording's "FFmpeg failed" string match,
        // since the thrown error could be a non-FFmpeg error (disk, OOM,
        // permission) that wouldn't trip that check.
        //
        // Preserve any terminal end_reason already set by the state
        // machine (e.g. TimeoutWaitingToStart from waiting-room-state):
        // post-processing failure shouldn't clobber the real cause.
        console.warn("❌ Audio-only recording produced no audio; marking bot-removed-too-early")
        if (!GLOBAL.hasError()) {
          GLOBAL.setError(MeetingEndReason.BotRemovedTooEarly)
        } else {
          console.log(
            `Preserving existing end_reason ${GLOBAL.getEndReason()} instead of overriding with BotRemovedTooEarly`
          )
        }
        throw error
      }
      console.warn("⚠️ Continuing without audio extraction to prevent bot hang (video mode)")
      // Don't throw - the video mp4 is still deliverable on its own in
      // speaker_view / gallery_view modes
    }

    // Integrity gate: a bot admitted then removed within seconds can produce empty audio
    // and a corrupt/near-empty video, while each finalize step above swallows its own
    // failure ("still deliverable on its own") — and getDuration is now non-fatal, so a
    // corrupt file no longer even throws at the probe. Before declaring success, require the
    // final output to actually contain something. This is checked by byte size, NOT ffprobe,
    // so an ffprobe timeout/wall-clock fallback cannot mask an empty recording. If there is
    // nothing usable, report BotRemovedTooEarly so the bot emits recording_failed instead of
    // a silent-success callback with a broken artifact. (audio_only already fails above.)
    const fileSize = (p: string): number => (fs.existsSync(p) ? fs.statSync(p).size : 0)
    const videoBytes = fileSize(this.outputPath)
    const audioBytes = fileSize(this.audioOutputPath)
    // 50 KB is far above a header-only / corrupt stub (the failing bot produced a ~200-byte
    // mp4) yet well below any real recording — even a few seconds of video exceeds it.
    const MIN_USABLE_OUTPUT_BYTES = 50 * 1024
    if (videoBytes < MIN_USABLE_OUTPUT_BYTES && audioBytes < MIN_USABLE_OUTPUT_BYTES) {
      console.warn(
        `❌ Final recording has no usable content (video=${videoBytes}B, audio=${audioBytes}B) — marking bot-removed-too-early`
      )
      // Preserve any terminal end_reason the state machine already set (e.g. botRemoved).
      if (!GLOBAL.hasError()) {
        GLOBAL.setError(MeetingEndReason.BotRemovedTooEarly)
      }
      throw new Error(
        `Recording produced no usable content (video=${videoBytes}B, audio=${audioBytes}B)`
      )
    }

    // 10. Cleanup temporary files
    await this.cleanupTempFiles()

    console.log("✅ Efficient sync and merge completed successfully")
  }

  private async addSilencePadding(
    inputAudioPath: string,
    outputAudioPath: string,
    paddingSeconds: number
  ): Promise<void> {
    const tempDir = PathManager.getInstance().getTempPath()
    const silenceFile = path.join(tempDir, "silence.flac")
    const concatListFile = path.join(tempDir, "concat_list.txt")

    // Create silence file with exact same format as input
    const silenceArgs = [
      "-f",
      "lavfi",
      "-i",
      `anullsrc=channel_layout=mono:sample_rate=${AUDIO_SAMPLE_RATE}:duration=${paddingSeconds}`,
      "-sample_fmt",
      "s16",
      "-ar",
      AUDIO_SAMPLE_RATE.toString(),
      "-ac",
      "1",
      "-y",
      silenceFile
    ]

    console.log(`🔇 Creating ${paddingSeconds.toFixed(3)}s silence file`)
    await this.runFFmpeg(silenceArgs, "addSilencePadding", paddingSeconds)

    // Create concat list with absolute paths (no escaping needed)
    const absoluteSilencePath = path.resolve(silenceFile)
    const absoluteInputPath = path.resolve(inputAudioPath)

    const concatContent = `file '${absoluteSilencePath}'
file '${absoluteInputPath}'`

    fs.writeFileSync(concatListFile, concatContent, "utf8")
    console.log("📝 Created concat list:")
    console.log(`   - ${absoluteSilencePath}`)
    console.log(`   - ${absoluteInputPath}`)

    // Concatenate using concat demuxer with re-encoding for clean timestamps
    const concatArgs = [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListFile,
      "-sample_fmt",
      "s16", // Re-encode instead of copy to ensure clean timestamps
      "-ar",
      AUDIO_SAMPLE_RATE.toString(),
      "-ac",
      "1",
      "-y",
      outputAudioPath
    ]

    console.log("🔇 Concatenating with demuxer (re-encoding for clean timestamps)")
    await this.runFFmpeg(concatArgs, "addSilencePadding", paddingSeconds)

    // Cleanup temp files
    if (fs.existsSync(silenceFile)) {
      fs.unlinkSync(silenceFile)
    }
    if (fs.existsSync(concatListFile)) {
      fs.unlinkSync(concatListFile)
    }
  }

  private async trimAudioStart(
    inputAudioPath: string,
    outputAudioPath: string,
    trimSeconds: number
  ): Promise<void> {
    const args = [
      "-i",
      inputAudioPath,
      "-ss",
      trimSeconds.toString(),
      "-sample_fmt",
      "s16", // Re-encode instead of copy to ensure clean timestamps
      "-ar",
      AUDIO_SAMPLE_RATE.toString(),
      "-ac",
      "1",
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      outputAudioPath
    ]

    console.log(
      `✂️ Trimming ${trimSeconds.toFixed(3)}s from audio start (re-encoding for clean timestamps)`
    )
    await this.runFFmpeg(args, "trimAudioStart", trimSeconds)
  }

  private async mergeWithSync(
    videoPath: string,
    audioPath: string,
    outputPath: string
  ): Promise<void> {
    const args = [
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c:v",
      "copy", // Ultra-fast copy - video already has frequent keyframes from recording
      "-c:a",
      "aac", // Convert to AAC during merge to avoid re-encoding later
      "-b:a",
      AUDIO_BITRATE,
      "-shortest",
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      outputPath
    ]

    console.log(
      "🎬 Merging video and audio (ultra-fast copy + AAC audio - keyframes already optimized)"
    )

    // Estimate file size for timeout calculation
    const videoSizeMB = this.estimateFileSizeMB(videoPath)
    const audioSizeMB = this.estimateFileSizeMB(audioPath)
    const estimatedSizeMB = videoSizeMB + audioSizeMB

    await this.runFFmpeg(args, "mergeWithSync", estimatedSizeMB)
  }

  private async finalTrimFromOffset(
    inputPath: string,
    outputPath: string,
    calcOffset: number,
    duration: number
  ): Promise<void> {
    // Now we can use ultra-fast copy mode since the merged file has frequent keyframes
    // The video was re-encoded during merge with keyframes every 1 second
    const args = [
      "-i",
      inputPath,
      "-ss",
      calcOffset.toString(),
      "-t",
      duration.toString(),
      "-c:v",
      "copy", // Ultra-fast copy mode - no keyframe issues thanks to frequent keyframes
      "-c:a",
      "copy", // Copy audio stream since it's already AAC
      "-movflags",
      "+faststart",
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      outputPath
    ]

    console.log(
      `✂️ Final trim: ultra-fast copy mode ${duration.toFixed(2)}s from ${calcOffset.toFixed(3)}s (frequent keyframes = no freeze)`
    )

    // Estimate file size for timeout calculation
    const estimatedSizeMB = this.estimateFileSizeMB(inputPath)

    await this.runFFmpeg(args, "finalTrimFromOffset", estimatedSizeMB)
  }

  /**
   * Read the video's keyframe timestamps (in seconds, relative to stream start).
   * Used to snap pause windows so FFmpeg concat cuts and diarization adjustments
   * land on the same boundaries — otherwise the ±1s keyframe snap drifts speaker
   * labels relative to the trimmed video.
   */
  private async getKeyframePositions(videoPath: string): Promise<number[]> {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-skip_frame",
      "nokey",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "csv=p=0",
      videoPath
    ]
    try {
      const result = await this.runFFprobe(args)
      return result
        .trim()
        .split("\n")
        .map((s) => Number.parseFloat(s))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)
    } catch (error) {
      // Non-fatal: keyframe probing only refines pause-window cut points. If it
      // fails (probe timeout / killed process), return no keyframes — the caller
      // (snapPauseWindowsToKeyframes) already skips snapping on an empty result,
      // so pause trimming proceeds with unsnapped timestamps rather than failing
      // the whole recording during finalization.
      console.warn(
        `⚠️ getKeyframePositions failed for ${videoPath}; continuing without keyframe snapping (non-fatal):`,
        formatError(error),
      )
      return []
    }
  }

  /**
   * Return the nearest value in a sorted array. Assumes `sorted` is non-empty.
   */
  private static snapToNearest(time: number, sorted: number[]): number {
    if (time <= sorted[0]) return sorted[0]
    if (time >= sorted[sorted.length - 1]) return sorted[sorted.length - 1]
    let lo = 0
    let hi = sorted.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] < time) lo = mid
      else hi = mid
    }
    return time - sorted[lo] <= sorted[hi] - time ? sorted[lo] : sorted[hi]
  }

  /**
   * Snap every pause window start/end to the nearest keyframe timestamp.
   * Returns new pause windows with adjusted absolute (ms) timestamps.
   * When ffprobe returns no keyframes, returns the input unchanged.
   */
  private async snapPauseWindowsToKeyframes(
    videoPath: string,
    pauseWindows: Array<{ start: number; end: number | null }>,
    meetingStartTime: number
  ): Promise<Array<{ start: number; end: number | null }>> {
    const keyframes = await this.getKeyframePositions(videoPath)
    if (keyframes.length === 0) {
      console.warn("⚠️ No keyframes found — skipping pause window snapping")
      return pauseWindows
    }

    const snapped: Array<{ start: number; end: number | null }> = []
    for (const w of pauseWindows) {
      const startS = (w.start - meetingStartTime) / 1000
      const snappedStartS = ScreenRecorder.snapToNearest(startS, keyframes)
      const snappedStart = Math.round(meetingStartTime + snappedStartS * 1000)

      let snappedEnd: number | null = null
      if (w.end !== null) {
        const endS = (w.end - meetingStartTime) / 1000
        const snappedEndS = ScreenRecorder.snapToNearest(endS, keyframes)
        snappedEnd = Math.round(meetingStartTime + snappedEndS * 1000)
      }

      console.log(
        `🎯 Pause window snapped: [${((w.start - meetingStartTime) / 1000).toFixed(3)}s, ${w.end !== null ? `${((w.end - meetingStartTime) / 1000).toFixed(3)}s` : "end"
        }] → [${((snappedStart - meetingStartTime) / 1000).toFixed(3)}s, ${snappedEnd !== null ? `${((snappedEnd - meetingStartTime) / 1000).toFixed(3)}s` : "end"
        }]`
      )

      // Drop zero-length or inverted post-snap windows. Happens for very short
      // pauses where both endpoints snap to the same keyframe — the window
      // contributes nothing to the trim and can confuse downstream cursor logic.
      if (snappedEnd !== null && snappedStart >= snappedEnd) {
        console.warn(
          `⚠️ Dropping post-snap zero-length pause window at ${(
            (snappedStart - meetingStartTime) / 1000
          ).toFixed(3)}s (pre-snap duration: ${w.end !== null ? ((w.end - w.start) / 1000).toFixed(3) : "∞"
          }s)`
        )
        continue
      }

      snapped.push({ start: snappedStart, end: snappedEnd })
    }
    return snapped
  }

  /**
   * Trim paused sections from the final video using the concat demuxer.
   * Operates in-place: reads from outputPath, writes to a temp file, then replaces.
   * Uses stream copy (-c:v copy -c:a copy) for speed — cuts snap to nearest keyframe (~1s).
   */
  private async trimPauseWindows(
    outputPath: string,
    pauseWindows: Array<{ start: number; end: number | null }>,
    meetingStartTime: number
  ): Promise<void> {
    console.log(`✂️ Trimming ${pauseWindows.length} pause window(s) from recording`)

    // Get video duration to handle open-ended windows
    const videoDuration = await this.getDuration(outputPath)

    // Convert absolute timestamps to offsets relative to meetingStartTime (in seconds),
    // sort by start, and drop degenerate (start >= end) entries. Sort+filter is
    // defensive — the server lock should produce non-overlapping windows in
    // order, but recovery-mode replay or state corruption could still feed us
    // unsorted or zero-length entries.
    const windows = pauseWindows
      .map((w) => ({
        start: (w.start - meetingStartTime) / 1000,
        end: w.end !== null ? (w.end - meetingStartTime) / 1000 : videoDuration
      }))
      .filter((w) => w.end > w.start)
      .sort((a, b) => a.start - b.start)

    // Build kept segments (non-paused sections). `cursor = Math.max(cursor, w.end)`
    // prevents the cursor ever moving backward when two windows overlap (w2
    // fully contained in w1), which would otherwise cause a later iteration
    // to emit a segment covering paused content.
    const segments: Array<{ inpoint: number; outpoint: number }> = []
    let cursor = 0
    for (const w of windows) {
      if (w.start > cursor) {
        segments.push({ inpoint: cursor, outpoint: w.start })
      }
      cursor = Math.max(cursor, w.end)
    }
    if (cursor < videoDuration) {
      segments.push({ inpoint: cursor, outpoint: videoDuration })
    }

    if (segments.length === 0) {
      console.warn(
        "⚠️ No kept segments after trimming pause windows — entire recording was paused. Producing minimal output."
      )
      // Produce a minimal valid MP4 (1 frame ≈ 33ms at 30fps) so downstream code
      // has a valid artifact to work with. Leaving the full untrimmed recording
      // would contradict the user's intent to pause the entire recording.
      const trimmedPath = path.join(PathManager.getInstance().getTempPath(), "pause_trimmed.mp4")
      const minimalArgs = [
        "-i",
        outputPath,
        "-t",
        "0.04",
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        "-y",
        trimmedPath
      ]
      await this.runFFmpeg(minimalArgs, "trimPauseWindowsEmpty", 1)
      fs.copyFileSync(trimmedPath, outputPath)
      fs.unlinkSync(trimmedPath)
      return
    }

    // Build concat demuxer file
    const tempDir = PathManager.getInstance().getTempPath()
    const segmentsFile = path.join(tempDir, "pause_segments.txt")
    const trimmedPath = path.join(tempDir, "pause_trimmed.mp4")
    const absoluteOutputPath = path.resolve(outputPath)

    const segmentsContent = segments
      .map(
        (s) =>
          `file '${absoluteOutputPath}'\ninpoint ${s.inpoint.toFixed(3)}\noutpoint ${s.outpoint.toFixed(3)}`
      )
      .join("\n\n")

    fs.writeFileSync(segmentsFile, segmentsContent, "utf8")
    console.log(`📝 Created pause segments file with ${segments.length} segment(s)`)

    const args = [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      segmentsFile,
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      trimmedPath
    ]

    const estimatedSizeMB = this.estimateFileSizeMB(outputPath)
    await this.runFFmpeg(args, "trimPauseWindows", estimatedSizeMB)

    // Replace original with trimmed version
    fs.copyFileSync(trimmedPath, outputPath)
    fs.unlinkSync(trimmedPath)
    fs.unlinkSync(segmentsFile)

    const trimmedDuration = await this.getDuration(outputPath)
    const totalPauseDuration = windows.reduce((sum, w) => sum + (w.end - w.start), 0)
    console.log(
      `✅ Pause trimming complete: ${videoDuration.toFixed(1)}s → ${trimmedDuration.toFixed(1)}s (removed ${totalPauseDuration.toFixed(1)}s of paused content)`
    )
  }

  /**
   * Adjust diarization timestamps to account for trimmed pause windows.
   * Discards entries that fall within pause windows, shifts remaining entries back.
   */
  private adjustDiarizationForPauseWindows(
    diarizationPath: string,
    pauseWindows: Array<{ start: number; end: number | null }>,
    meetingStartTime: number
  ): void {
    // Convert to seconds relative to meetingStartTime
    const windows = pauseWindows.map((w) => ({
      start: (w.start - meetingStartTime) / 1000,
      end: w.end !== null ? (w.end - meetingStartTime) / 1000 : Number.POSITIVE_INFINITY
    }))

    const content = fs.readFileSync(diarizationPath, "utf8")
    const lines = content.trim().split("\n").filter(Boolean)
    const adjusted: string[] = []
    let parseFailures = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let segment: { start_time: number; end_time: number;[key: string]: unknown }
      try {
        segment = JSON.parse(line)
      } catch (err) {
        // A single malformed line shouldn't abort the whole adjustment and
        // leave the file unadjusted — downstream would upload diarization
        // with pre-trim wall-clock timestamps. Skip and keep going.
        parseFailures++
        console.warn(
          `⚠️ Diarization line ${i} in ${diarizationPath} is malformed, skipping: ${err instanceof Error ? err.message : String(err)
          }`
        )
        continue
      }

      const adjustedStart = this.adjustTimestamp(segment.start_time, windows)
      const adjustedEnd = this.adjustTimestamp(segment.end_time, windows)

      // Segment fully inside a pause window collapses to zero length here
      // and is discarded below. Segments that straddle a pause boundary
      // keep their pre-pause or post-resume portion.
      if (adjustedEnd <= adjustedStart) continue

      segment.start_time = adjustedStart
      segment.end_time = adjustedEnd
      adjusted.push(JSON.stringify(segment))
    }

    fs.writeFileSync(
      diarizationPath,
      adjusted.join("\n") + (adjusted.length > 0 ? "\n" : ""),
      "utf8"
    )
    console.log(
      `✂️ Diarization adjusted: ${lines.length} segments → ${adjusted.length} segments (${lines.length - adjusted.length
      } removed${parseFailures > 0 ? `, of which ${parseFailures} malformed` : ""})`
    )
  }

  /**
   * Map a timestamp onto the post-trim timeline. Any timestamp falling inside
   * a pause window [ws, we) is clamped to `we`, then shifted by the total
   * paused duration that occurred strictly before it. The entire pause window
   * collapses to a single point in post-trim time, so both boundaries yield
   * the same post-shift value — straddling segments keep their pre- or
   * post-pause portion rather than being dropped outright.
   */
  private adjustTimestamp(t: number, pauseWindows: Array<{ start: number; end: number }>): number {
    let tAdj = t
    for (const w of pauseWindows) {
      if (tAdj >= w.start && tAdj < w.end) {
        tAdj = w.end
      }
    }
    let cumulativePause = 0
    for (const w of pauseWindows) {
      if (w.end <= tAdj) cumulativePause += w.end - w.start
    }
    return tAdj - cumulativePause
  }

  private async extractAudioFromVideo(videoPath: string, audioPath: string): Promise<void> {
    const args = [
      "-i",
      videoPath,
      "-vn",
      "-sample_fmt",
      "s16",
      "-ar",
      AUDIO_SAMPLE_RATE.toString(),
      "-ac",
      "1",
      "-y",
      audioPath
    ]

    console.log("🎵 Extracting audio from video (converting to FLAC 16kHz mono)")

    // Estimate file size for timeout calculation
    const estimatedSizeMB = this.estimateFileSizeMB(videoPath)

    await this.runFFmpeg(args, "extractAudioFromVideo", estimatedSizeMB)
  }

  /**
   * Split the full audio file into FLAC chunks for transcription upload.
   *
   * We use one FFmpeg invocation per chunk with explicit `-ss`/`-t` instead of
   * the segment muxer (`-f segment -segment_format flac`) because the segment
   * muxer produces FLAC files with incorrect metadata:
   *   - Chunk 0 gets `duration: N/A` (missing `total_samples` in STREAMINFO)
   *   - Subsequent chunks inherit the full source duration and a non-zero `start_time`
   * Gladia rejects chunks whose metadata duration exceeds 8100s, even though the
   * actual audio content is shorter. Per-chunk seeking avoids this entirely since
   * each output is a standalone FLAC with correct `total_samples` and `start_time=0`.
   */
  private async createAudioChunks(audioPath: string): Promise<void> {
    if (!UPLOAD_AUDIO_CHUNKS) return

    const chunksDir = PathManager.getInstance().getAudioTmpPath()
    if (!fs.existsSync(chunksDir)) {
      fs.mkdirSync(chunksDir, { recursive: true })
    }

    // Get audio file size and duration
    let fileSizeBytes = 0
    let fileSizeMB = "unknown"
    if (fs.existsSync(audioPath)) {
      const stats = fs.statSync(audioPath)
      fileSizeBytes = stats.size
      fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2)
    }

    // Get audio duration
    const actualDuration = await this.getDuration(audioPath)
    const botUuid = GLOBAL.get().bot_uuid

    // Add 1 second margin to avoid floating-point precision issues in duration reporting
    const durationWithMargin = actualDuration + 1

    // Calculate total number of chunks
    const totalChunks = Math.ceil(durationWithMargin / TRANSCRIPTION_CHUNK_DURATION)

    console.log(
      `🎵 Creating ${totalChunks} audio chunk(s) (${TRANSCRIPTION_CHUNK_DURATION}s max each) from ${actualDuration.toFixed(1)}s audio`
    )
    console.log(
      `📊 Audio file size: ${fileSizeMB} MB (${fileSizeBytes} bytes) | Duration: ${actualDuration.toFixed(1)}s`
    )

    try {
      // Estimate file size for timeout calculation
      const estimatedSizeMB = this.estimateFileSizeMB(audioPath)

      for (let i = 0; i < totalChunks; i++) {
        const startTime = i * TRANSCRIPTION_CHUNK_DURATION
        const chunkLength = Math.min(TRANSCRIPTION_CHUNK_DURATION, durationWithMargin - startTime)
        const outputPath = path.join(chunksDir, `${botUuid}-${i}.flac`)

        console.log(
          `🎵 Creating chunk ${i + 1}/${totalChunks}: ${startTime}s-${(startTime + chunkLength).toFixed(1)}s`
        )

        const args = [
          "-ss",
          startTime.toString(),
          "-i",
          audioPath,
          "-t",
          chunkLength.toString(),
          "-sample_fmt",
          "s16",
          "-ac",
          "1",
          "-ar",
          AUDIO_SAMPLE_RATE.toString(),
          "-y",
          outputPath
        ]

        await this.runFFmpeg(args, "createAudioChunk", estimatedSizeMB)
      }

      // Upload created chunks
      await this.uploadAudioChunks(chunksDir, botUuid)
    } catch (error) {
      console.warn(`⚠️ Audio chunking failed (likely due to bot removal): ${error}`)
      console.warn("⚠️ Continuing without audio chunks to prevent bot hang")
      // Don't throw - allow cleanup to continue
    }
  }

  /**
   * Estimate file size in MB for timeout calculation
   */
  private estimateFileSizeMB(filePath: string): number {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath)
        return Math.round(stats.size / (1024 * 1024))
      }
    } catch (error) {
      console.warn("Could not estimate file size for timeout calculation:", error)
    }
    return 100 // Default estimate
  }

  private async getDuration(filePath: string): Promise<number> {
    let fileSizeMB: number | undefined
    try {
      const stats = fs.statSync(filePath)
      fileSizeMB = Math.round((stats.size / (1024 * 1024)) * 10) / 10
    } catch {
      console.warn(
        `⚠️ Could not stat file for getDuration timeout calculation: ${filePath}, using base timeout`,
      )
    }

    const args = ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", filePath]
    try {
      const result = await this.runFFprobe(args, fileSizeMB)
      const duration = Number.parseFloat(result.trim())
      if (Number.isFinite(duration) && duration > 0) return duration
    } catch (error) {
      console.warn(`⚠️ getDuration ffprobe failed for ${filePath}:`, formatError(error))
    }

    // Non-fatal: ffprobe duration probing is best-effort (originally added only to
    // chunk long audio for Gladia's max-duration limit). A slow probe on a multi-GB
    // file must never discard an otherwise-complete recording during finalization.
    // Fall back to the wall-clock recording span — an UPPER bound on real content,
    // so any downstream `-t` trim clamps to end-of-file instead of truncating footage.
    const fallback =
      this.recordingStartTime > 0 ? (Date.now() - this.recordingStartTime) / 1000 : 24 * 60 * 60
    console.warn(`⚠️ Using wall-clock duration fallback ${fallback.toFixed(1)}s (non-fatal)`)
    return fallback
  }

  private async cleanupTempFiles(): Promise<void> {
    // for (const filePath of filePaths) {
    //     if (fs.existsSync(filePath)) {
    //         fs.unlinkSync(filePath)
    //         console.log(`🗑️ Cleaned up: ${path.basename(filePath)}`)
    //     }
    // }
  }

  private async runFFmpeg(
    args: string[],
    operation = "unknown",
    fileSizeMB?: number
  ): Promise<void> {
    const timeout = calculateFFmpegTimeout(operation, fileSizeMB)

    console.log(
      `⏱️ FFmpeg ${operation}: timeout set to ${timeout / 1000}s${fileSizeMB ? ` (estimated file size: ${fileSizeMB}MB)` : ""}`
    )

    return new Promise((resolve, reject) => {
      const process = spawn("ffmpeg", args)
      let stderr = ""

      // Capture stderr for better error reporting
      process.stderr?.on("data", (data) => {
        stderr += data.toString()
      })

      process.on("close", (code) => {
        if (code === 0) {
          resolve()
        } else {
          // Provide more specific error information
          const errorMsg = `FFmpeg failed with code ${code}`
          const stderrPreview = stderr.split("\n").slice(-3).join("\n") // Last 3 lines
          console.error(`❌ ${errorMsg}`)
          if (stderrPreview) {
            console.error(`❌ FFmpeg stderr: ${stderrPreview}`)
          }
          reject(new Error(errorMsg))
        }
      })

      process.on("error", (error) => {
        console.error(`❌ FFmpeg process error: ${error.message}`)
        reject(error)
      })

      // Add dynamic timeout to prevent hanging
      const timeoutId = setTimeout(() => {
        console.error(
          `❌ FFmpeg timeout after ${timeout / 1000}s for ${operation}, killing process`
        )
        process.kill("SIGKILL")
        reject(new Error(`FFmpeg timeout for ${operation}`))
      }, timeout)

      process.on("close", () => {
        clearTimeout(timeoutId)
      })
    })
  }

  private async runFFprobe(
    args: string[],
    fileSizeMB?: number,
  ): Promise<string> {
    const timeout = calculateFFmpegTimeout("getDuration", fileSizeMB)

    console.log(
      `⏱️ FFprobe getDuration: timeout set to ${timeout / 1000}s${fileSizeMB ? ` (estimated file size: ${fileSizeMB}MB)` : ""}`,
    )

    return new Promise((resolve, reject) => {
      const process = spawn("ffprobe", args)
      let output = ""

      process.stdout?.on("data", (data) => {
        output += data.toString()
      })

      process.on("close", (code) => {
        if (code === 0) {
          resolve(output)
        } else {
          reject(new Error(`FFprobe failed with code ${code}`))
        }
      })

      process.on("error", (error) => {
        reject(error)
      })

      const timeoutId = setTimeout(() => {
        console.error(
          `❌ FFprobe timeout after ${timeout / 1000}s for getDuration, killing process`,
        )
        process.kill("SIGKILL")
        reject(new Error("FFprobe timeout"))
      }, timeout)

      process.on("close", () => {
        clearTimeout(timeoutId)
      })
    })
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: This provides a singleton instance of the ScreenRecorder class
export class ScreenRecorderManager {
  private static instance: ScreenRecorder

  public static getInstance(): ScreenRecorder {
    if (!ScreenRecorderManager.instance) {
      ScreenRecorderManager.instance = new ScreenRecorder()
    }
    return ScreenRecorderManager.instance
  }
}
