import { spawn } from "node:child_process"

// Detects "chopped" audio: short runs of EXACT digital zeros punched into
// active speech. Chromium zero-fills any part of an audio output callback its
// renderer source can't supply (pulse_output.cc ZeroFramesPartial). Real
// silence, packet-loss concealment and comfort noise are never exact zeros
// flanked by loud audio, so this signature is specific to the output path.
// Seen in prod (Oct 2026) as ~80ms holes every ~170ms (= one 8192-frame
// callback) for minutes at a time on Teams bots.

const ANALYSIS_RATE = 16_000
const EDGE_SAMPLES = ANALYSIS_RATE / 100 // 10ms of audio on each side of a hole
const MIN_HOLE_SAMPLES = (ANALYSIS_RATE * 60) / 1000
const MAX_HOLE_SAMPLES = (ANALYSIS_RATE * 100) / 1000
const LOUD_RMS = 0.02 * 32768 // edges must be speech, not near-silence
const CHOPPED_HOLES_PER_MINUTE = 20
const DECODE_TIMEOUT_MS = 180_000

export interface AudioHolesResult {
  durationSeconds: number
  holes: number
  holesPerMinute: number[]
  maxHolesPerMinute: number
  chopped: boolean
  /** Seconds into the analyzed file of the first/last minute with >= CHOPPED_HOLES_PER_MINUTE holes */
  choppedFromSeconds: number | null
  choppedToSeconds: number | null
}

/** Streaming detector over 16 kHz mono s16 samples; holds O(1) state. */
export class AudioHoleDetector {
  private position = 0
  private zeroRun = 0
  private zeroRunStart = 0
  // Rolling sum of squares for the last EDGE_SAMPLES before the current sample
  private readonly preWindow = new Float64Array(EDGE_SAMPLES)
  private preIndex = 0
  private preSumSquares = 0
  private preRmsAtRunStart = 0
  // A finished zero run of hole length waiting for its trailing 10ms
  private pendingStart = -1
  private pendingSumSquares = 0
  private pendingCount = 0
  private readonly holeStarts: number[] = []

  push(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i]

      if (this.pendingStart >= 0) {
        this.pendingSumSquares += sample * sample
        this.pendingCount++
        if (this.pendingCount === EDGE_SAMPLES) {
          if (Math.sqrt(this.pendingSumSquares / EDGE_SAMPLES) > LOUD_RMS) {
            this.holeStarts.push(this.pendingStart)
          }
          this.pendingStart = -1
        }
      }

      if (sample === 0) {
        if (this.zeroRun === 0) {
          this.zeroRunStart = this.position
          this.preRmsAtRunStart = Math.sqrt(this.preSumSquares / EDGE_SAMPLES)
        }
        this.zeroRun++
      } else {
        if (
          this.zeroRun >= MIN_HOLE_SAMPLES &&
          this.zeroRun <= MAX_HOLE_SAMPLES &&
          this.preRmsAtRunStart > LOUD_RMS &&
          this.pendingStart < 0
        ) {
          this.pendingStart = this.zeroRunStart
          this.pendingSumSquares = sample * sample
          this.pendingCount = 1
        }
        this.zeroRun = 0
      }

      const squared = sample * sample
      this.preSumSquares += squared - this.preWindow[this.preIndex]
      this.preWindow[this.preIndex] = squared
      this.preIndex = (this.preIndex + 1) % EDGE_SAMPLES
      this.position++
    }
  }

  result(): AudioHolesResult {
    const minutes = Math.max(1, Math.ceil(this.position / ANALYSIS_RATE / 60))
    const holesPerMinute = new Array<number>(minutes).fill(0)
    for (const start of this.holeStarts) {
      holesPerMinute[Math.floor(start / ANALYSIS_RATE / 60)]++
    }
    const choppedMinutes = holesPerMinute
      .map((count, minute) => (count >= CHOPPED_HOLES_PER_MINUTE ? minute : -1))
      .filter((minute) => minute >= 0)
    const holeSeconds = this.holeStarts.map((start) => start / ANALYSIS_RATE)
    const firstChopped = choppedMinutes.length > 0 ? choppedMinutes[0] : -1
    const lastChopped = choppedMinutes.length > 0 ? choppedMinutes[choppedMinutes.length - 1] : -1

    return {
      durationSeconds: this.position / ANALYSIS_RATE,
      holes: this.holeStarts.length,
      holesPerMinute,
      maxHolesPerMinute: Math.max(0, ...holesPerMinute),
      chopped: choppedMinutes.length > 0,
      // Bound the window by the actual holes inside the first/last chopped minutes
      choppedFromSeconds:
        firstChopped >= 0
          ? (holeSeconds.find((s) => Math.floor(s / 60) === firstChopped) ?? firstChopped * 60)
          : null,
      choppedToSeconds:
        lastChopped >= 0
          ? (holeSeconds.filter((s) => Math.floor(s / 60) === lastChopped).pop() ?? (lastChopped + 1) * 60)
          : null
    }
  }
}

/** Decodes an audio file with FFmpeg (16 kHz mono s16) and runs the detector over it. */
export async function detectAudioHoles(filePath: string): Promise<AudioHolesResult> {
  const detector = new AudioHoleDetector()

  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(
      "ffmpeg",
      ["-v", "error", "-i", filePath, "-f", "s16le", "-ac", "1", "-ar", String(ANALYSIS_RATE), "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL")
      reject(new Error(`audio hole detection timed out after ${DECODE_TIMEOUT_MS / 1000}s`))
    }, DECODE_TIMEOUT_MS)

    // Chunks can split a 2-byte sample; carry the odd byte over.
    let carry: Buffer | null = null
    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      const data = carry ? Buffer.concat([carry, chunk]) : chunk
      const usable = data.length - (data.length % 2)
      carry = usable < data.length ? data.subarray(usable) : null
      const aligned = Buffer.from(data.subarray(0, usable))
      detector.push(new Int16Array(aligned.buffer, aligned.byteOffset, usable / 2))
    })

    let stderr = ""
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000)
    })
    ffmpeg.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    ffmpeg.on("close", (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`))
    })
  })

  return detector.result()
}
