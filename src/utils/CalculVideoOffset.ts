/**
 * Utility to calculate synchronization offset between audio beep and video flash
 * Analyzes audio file for 1000Hz beep and video file for green flash
 * Returns the time offset needed to synchronize the files
 */

import { exec } from "node:child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

// Configuration constants
const EXPECTED_FREQUENCY = 1000
const ANALYSIS_WINDOW = 10 // Analyze first 10 seconds (used as fallback upper bound)
// Half-width of the search window centred on the known sync-signal position.
// Keep tight (±0.5 s) to avoid matching early meeting-UI content or noise, while
// still tolerating normal system jitter on the sleep/page-evaluate path.
const SYNC_WINDOW_HALF_WIDTH_SEC = 0.5
// The video flash routinely lands EARLIER than the audio beep even though they
// fire together: x11grab's capture pipeline starts with more latency than
// PulseAudio, so the flash's video-stream timestamp is pulled below the tight
// audio window and gets missed. Search further back (but not forward) for the
// flash so a slow capture start doesn't drop it. The green + scene-change
// detector makes an early false positive very unlikely (pre-join UI isn't
// fullscreen green).
const VIDEO_SYNC_WINDOW_BACK_SEC = 2.0

interface SyncOffset {
  /** Audio signal timestamp in seconds */
  audioTimestamp: number
  /** Video signal timestamp in seconds */
  videoTimestamp: number
  /** Calculated offset in seconds (positive means video is ahead) */
  offsetSeconds: number
  /** Quality/confidence of detection (0-1) */
  confidence: number
}

/**
 * Calculate synchronization offset between audio and video files
 * @param audioPath - Path to audio file (.wav)
 * @param videoPath - Path to video file (.webm, .mp4, etc.)
 * @param expectedSyncSec - Exact seconds-from-recording-start when generateSyncSignal was called.
 *   The search window is clamped to [expectedSyncSec ± SYNC_WINDOW_HALF_WIDTH_SEC].
 *   Required — callers must pass the recorded syncSignalTimestamp offset so detection
 *   cannot be fooled by early meeting-UI content (authenticated bots) or noise.
 * @returns Promise<SyncOffset> - Synchronization information
 */
export async function calculateVideoOffset(
  audioPath: string,
  videoPath: string,
  expectedSyncSec: number
): Promise<SyncOffset> {
  const searchMin = Math.max(0, expectedSyncSec - SYNC_WINDOW_HALF_WIDTH_SEC)
  const searchMax = expectedSyncSec + SYNC_WINDOW_HALF_WIDTH_SEC
  // Wider, downward-biased window for the flash (see VIDEO_SYNC_WINDOW_BACK_SEC).
  const videoSearchMin = Math.max(0, expectedSyncSec - VIDEO_SYNC_WINDOW_BACK_SEC)
  const videoSearchMax = searchMax

  console.log(
    `🔍 Analyzing sync signals (audio ${searchMin.toFixed(2)}s – ${searchMax.toFixed(2)}s, video ${videoSearchMin.toFixed(2)}s – ${videoSearchMax.toFixed(2)}s)...`
  )
  console.log(`   Audio: ${audioPath}`)
  console.log(`   Video: ${videoPath}`)

  try {
    // Analyze both files in parallel using the sync windows
    const [audioTimestamp, videoTimestamp] = await Promise.all([
      detectAudioBeep(audioPath, searchMin, searchMax),
      detectVideoFlash(videoPath, videoSearchMin, videoSearchMax)
    ])

    // Validate that we found both signals
    if (audioTimestamp <= 0) {
      console.warn(`⚠️ Failed to detect audio beep in first ${ANALYSIS_WINDOW}s, using default`)
    }
    if (videoTimestamp <= 0) {
      console.warn(`⚠️ Failed to detect video flash in first ${ANALYSIS_WINDOW}s, using default`)
    }

    // If exactly one signal is missing, fall back to assuming the beep and flash
    // landed at the SAME timestamp. They are emitted simultaneously
    // (Promise.all in generateSyncSignal), so the detected signal's time is the
    // best estimate for both — this yields offsetSeconds 0 AND, downstream,
    // audioPadding = videoTimestamp - audioTimestamp = 0, so no stream is
    // shifted and A/V stays aligned as captured.
    //
    // The previous behaviour left the undetected timestamp at 0. When only the
    // beep was found (e.g. a software-rendered flash paints outside the tight
    // detection window), that made audioPadding = 0 - audioTimestamp, trimming
    // the FULL beep offset (~4.3s) off the audio and desyncing A/V by seconds.
    if (audioTimestamp <= 0 || videoTimestamp <= 0) {
      const bothMissing = audioTimestamp <= 0 && videoTimestamp <= 0
      const detected = audioTimestamp > 0 ? audioTimestamp : videoTimestamp
      const fallbackResult: SyncOffset = {
        audioTimestamp: bothMissing ? 0 : detected,
        videoTimestamp: bothMissing ? 0 : detected,
        offsetSeconds: 0.0,
        confidence: bothMissing ? 0.1 : 0.3
      }

      if (bothMissing) {
        console.warn("⚠️ Neither sync signal detected — assuming zero A/V offset")
      } else {
        console.warn(
          `⚠️ Only the ${audioTimestamp > 0 ? "audio beep" : "video flash"} was detected (at ${detected.toFixed(3)}s). Assuming simultaneous beep+flash → zero offset, no audio shift.`
        )
      }
      return fallbackResult
    }

    const offsetSeconds = videoTimestamp - audioTimestamp
    const confidence = 0.9 // High confidence if both signals detected

    const result: SyncOffset = {
      audioTimestamp,
      videoTimestamp,
      offsetSeconds,
      confidence
    }

    console.log("✅ Sync analysis complete:")
    console.log(`   Audio beep at: ${audioTimestamp.toFixed(3)}s`)
    console.log(`   Video flash at: ${videoTimestamp.toFixed(3)}s`)
    console.log(`   Offset: ${offsetSeconds.toFixed(3)}s`)
    console.log(`   Confidence: ${(confidence * 100).toFixed(1)}%`)

    return result
  } catch (error) {
    console.error("❌ Failed to calculate offset:", error)
    console.log("⚠️ Using fallback offset due to analysis error")

    // Return default offset with very low confidence
    const fallbackResult: SyncOffset = {
      audioTimestamp: 0,
      videoTimestamp: 0,
      offsetSeconds: 0.0,
      confidence: 0.05 // Very low confidence for error case
    }

    console.log("✅ Using fallback offset: 0.000s (confidence: 5.0%)")
    return fallbackResult
  }
}

/**
 * Detect 1000Hz beep in audio file using FFmpeg silence analysis.
 * Only considers timestamps within [searchMin, searchMax] to avoid false positives.
 */
async function detectAudioBeep(audioPath: string, searchMin: number, searchMax: number): Promise<number> {
  console.log(`🔊 Detecting ${EXPECTED_FREQUENCY}Hz beep in window [${searchMin.toFixed(2)}s – ${searchMax.toFixed(2)}s]...`)

  // Scan slightly beyond the window to capture events right at the boundary.
  const scanUntil = searchMax + 1

  // Band-limit around the 1000Hz sync tone before detecting activity. Without this,
  // ANY audio above the threshold in the window is taken as the beep (a join chime,
  // someone talking), and conversely continuous meeting audio before the beep means
  // no silence_end ever fires and the beep is missed entirely. The beep is a pure
  // near-full-scale 1kHz tone, so it survives the narrow band intact while broadband
  // speech/chimes are strongly attenuated.
  const beepBandFilter = `highpass=f=${EXPECTED_FREQUENCY - 150},lowpass=f=${EXPECTED_FREQUENCY + 150}`

  try {
    // Method 1: Use silence detection to find audio activity in the beep band
    const silenceCmd = `ffmpeg -i "${audioPath}" -af "${beepBandFilter},silencedetect=noise=-35dB:duration=0.01" -f null -t ${scanUntil} - 2>&1 | grep "silence_"`

    try {
      const { stdout: silenceOutput } = await execAsync(silenceCmd)
      const lines = silenceOutput.split("\n").filter((line) => line.includes("silence_"))

      for (const line of lines) {
        const endMatch = line.match(/silence_end: ([0-9.]+)/)
        if (endMatch) {
          const time = Number.parseFloat(endMatch[1])
          if (time >= searchMin && time <= searchMax) {
            console.log(`   Found audio activity (likely beep) at ${time.toFixed(3)}s`)
            return time
          }
        }
      }
    } catch (e) {
      console.log(
        `   Silence detection failed: ${e instanceof Error ? e.message : "Unknown error"}`
      )
    }

    // Method 2: More sensitive silence detection (still band-limited to the tone)
    const detailedCmd = `ffmpeg -i "${audioPath}" -af "${beepBandFilter},silencedetect=noise=-50dB:duration=0.005" -f null -t ${scanUntil} - 2>&1 | grep "silence_end"`
    try {
      const { stdout: detailedOutput } = await execAsync(detailedCmd)
      const detailedLines = detailedOutput.split("\n").filter((line) => line.includes("silence_end"))

      for (const line of detailedLines) {
        const match = line.match(/silence_end: ([0-9.]+)/)
        if (match) {
          const time = Number.parseFloat(match[1])
          if (time >= searchMin && time <= searchMax) {
            console.log(`   Found audio activity with detailed analysis at ${time.toFixed(3)}s`)
            return time
          }
        }
      }
    } catch (e) {
      console.log(
        `   Detailed analysis failed: ${e instanceof Error ? e.message : "Unknown error"}`
      )
    }

    console.log(`   No beep detected in window [${searchMin.toFixed(2)}s – ${searchMax.toFixed(2)}s]`)
    return 0
  } catch (error) {
    console.warn(`⚠️ Audio analysis failed: ${error}`)
    return 0
  }
}

/**
 * Detect green flash in video file using color analysis.
 * Only considers timestamps within [searchMin, searchMax] to avoid false positives.
 */
async function detectVideoFlash(videoPath: string, searchMin: number, searchMax: number): Promise<number> {
  console.log(`💚 Detecting green flash in window [${searchMin.toFixed(2)}s – ${searchMax.toFixed(2)}s]...`)

  const scanUntil = searchMax + 1

  try {
    // Primary: scene detection filtered by green YUV color characteristics
    const sceneColorCmd = `ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.02)',showinfo" -vsync 0 -f null -t ${scanUntil} - 2>&1 | grep -E "(pts_time|mean:)"`

    try {
      const { stdout: sceneColorOutput } = await execAsync(sceneColorCmd)
      const lines = sceneColorOutput.split("\n")

      let currentTime = 0
      let currentMean = ""

      for (const line of lines) {
        const timeMatch = line.match(/pts_time:([0-9.]+)/)
        const meanMatch = line.match(/mean:\[([0-9. ]+)\]/)

        if (timeMatch) {
          currentTime = Number.parseFloat(timeMatch[1])
        }
        if (meanMatch) {
          currentMean = meanMatch[1]

          const values = currentMean.trim().split(/\s+/).map((v) => Number.parseFloat(v))
          if (values.length >= 3) {
            const [Y, U, V] = values

            // Green flash (#00FF00) in YUV: Y ≈ 149, U ≈ 43, V ≈ 21.
            // Only accept within the caller-supplied window.
            if (Y < 160 && U < 80 && V < 60 && currentTime >= searchMin && currentTime <= searchMax) {
              console.log(`   Found green flash at ${currentTime.toFixed(3)}s (color analysis)`)
              console.log(`   YUV values: [${Y.toFixed(1)} ${U.toFixed(1)} ${V.toFixed(1)}]`)
              return currentTime
            }
          }
        }
      }
    } catch (e) {
      console.log(`   Color analysis failed: ${e instanceof Error ? e.message : "Unknown error"}`)
    }

    // Fallback: largest scene change within the window
    try {
      const sceneCmd = `ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.05)',showinfo" -f null -t ${scanUntil} - 2>&1 | grep "pts_time"`

      const { stdout: sceneResult } = await execAsync(sceneCmd)
      const lines = sceneResult.split("\n").filter((line) => line.includes("pts_time"))

      let bestFlashTime = 0
      let bestSceneValue = 0

      for (const line of lines) {
        const timeMatch = line.match(/pts_time:([0-9.]+)/)
        const sceneMatch = line.match(/scene:([0-9.]+)/)

        if (timeMatch && sceneMatch) {
          const time = Number.parseFloat(timeMatch[1])
          const sceneValue = Number.parseFloat(sceneMatch[1])

          if (time >= searchMin && time <= searchMax && sceneValue > bestSceneValue) {
            bestFlashTime = time
            bestSceneValue = sceneValue
          }
        }
      }

      if (bestFlashTime > 0) {
        console.log(
          `   Fallback: Found scene change at ${bestFlashTime.toFixed(3)}s (scene value: ${bestSceneValue.toFixed(3)})`
        )
        return bestFlashTime
      }
    } catch (e) {
      console.log(
        `   Fallback scene detection failed: ${e instanceof Error ? e.message : "Unknown error"}`
      )
    }

    console.log(`   No green flash detected in window [${searchMin.toFixed(2)}s – ${searchMax.toFixed(2)}s]`)
    return 0
  } catch (error) {
    console.warn(`⚠️ Video analysis failed: ${error}`)
    return 0
  }
}

/**
 * Test function using the provided sample files
 */

// biome-ignore lint/correctness/noUnusedVariables: This is used for testings manually
async function testWithSampleFiles(): Promise<SyncOffset> {
  const audioPath =
    "/Users/philippedrion/OutOfIcloud/meeting-baas/meeting_bot/recording_server/recordings/test/output.wav"
  const videoPath =
    "/Users/philippedrion/OutOfIcloud/meeting-baas/meeting_bot/recording_server/recordings/test/output.mp4"

  return calculateVideoOffset(audioPath, videoPath, 4.5)
}

/**
 * Test function for the specific problematic video file
 * Uses color-based detection instead of scene detection
 */
// biome-ignore lint/correctness/noUnusedVariables: This is used for testings manually
async function testGreenFlashDetection(): Promise<SyncOffset> {
  const videoPath =
    "/Users/philippedrion/Documents/meeting-baas/meeting_bot/recording_server/recordings/47FED07F-401A-4E78-A810-044F4CE469BA/temp/raw.mp4"

  console.log("🧪 Testing green flash detection on specific video file...")
  console.log(`   Video: ${videoPath}`)

  try {
    // Use color-based detection instead of scene detection
    const videoTimestamp = await detectGreenFlashByColor(videoPath)

    const result: SyncOffset = {
      audioTimestamp: 0, // Not testing audio
      videoTimestamp,
      offsetSeconds: 0,
      confidence: videoTimestamp > 0 ? 0.95 : 0.1
    }

    console.log("✅ Green flash detection result:")
    console.log(`   Video flash at: ${videoTimestamp.toFixed(3)}s`)
    console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`)

    return result
  } catch (error) {
    console.error("❌ Green flash detection failed:", error)
    return {
      audioTimestamp: 0,
      videoTimestamp: 0,
      offsetSeconds: 0,
      confidence: 0.05
    }
  }
}

/**
 * Detect green flash using color analysis instead of scene detection
 * Looks for frames with specific YUV color characteristics of the green flash
 */
async function detectGreenFlashByColor(videoPath: string): Promise<number> {
  console.log(`💚 Detecting green flash using color analysis (first ${ANALYSIS_WINDOW}s)...`)

  try {
    // Method 1: Look for frames with low Y (luminance) and low V (blue chrominance)
    // Green flash has: Y ~140-150, U ~63, V ~46 (vs normal Y ~220, U ~128, V ~128)
    const colorCmd = `ffmpeg -i "${videoPath}" -vf "select='lt(YAVG,0.6)*lt(VAVG,0.4)',showinfo" -vsync 0 -f null -t ${ANALYSIS_WINDOW} - 2>&1 | grep "pts_time"`

    try {
      const { stdout: colorOutput } = await execAsync(colorCmd)
      const lines = colorOutput.split("\n").filter((line) => line.includes("pts_time"))

      console.log(`   Found ${lines.length} potential green flash frames`)

      // Look for the first significant green flash after 1s
      for (const line of lines) {
        const match = line.match(/pts_time:([0-9.]+)/)
        if (match) {
          const time = Number.parseFloat(match[1])
          if (time > 1.0 && time < ANALYSIS_WINDOW) {
            console.log(`   Found green flash at ${time.toFixed(3)}s (color-based detection)`)
            return time
          }
        }
      }
    } catch (e) {
      console.log(`   Color detection failed: ${e instanceof Error ? e.message : "Unknown error"}`)
    }

    // Method 2: Use scene detection but filter by color characteristics
    const sceneColorCmd = `ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.02)',showinfo" -vsync 0 -f null -t ${ANALYSIS_WINDOW} - 2>&1 | grep -E "(pts_time|mean:)"`

    try {
      const { stdout: sceneColorOutput } = await execAsync(sceneColorCmd)
      const lines = sceneColorOutput.split("\n")

      let currentTime = 0
      let currentMean = ""

      for (const line of lines) {
        const timeMatch = line.match(/pts_time:([0-9.]+)/)
        const meanMatch = line.match(/mean:\[([0-9. ]+)\]/)

        if (timeMatch) {
          currentTime = Number.parseFloat(timeMatch[1])
        }
        if (meanMatch) {
          currentMean = meanMatch[1]

          // Parse YUV values: mean:[Y U V]
          const values = currentMean
            .trim()
            .split(/\s+/)
            .map((v) => Number.parseFloat(v))
          if (values.length >= 3) {
            const [Y, U, V] = values

            // Check if this looks like a green flash:
            // Y (luminance) should be lower than normal (~140-150 vs ~220)
            // U (red chrominance) should be lower than normal (~63 vs ~128)
            // V (blue chrominance) should be much lower than normal (~46 vs ~128)
            if (Y < 160 && U < 80 && V < 60 && currentTime > 1.0 && currentTime < ANALYSIS_WINDOW) {
              console.log(
                `   Found green flash at ${currentTime.toFixed(3)}s (scene+color analysis)`
              )
              console.log(`   YUV values: [${Y.toFixed(1)} ${U.toFixed(1)} ${V.toFixed(1)}]`)
              return currentTime
            }
          }
        }
      }
    } catch (e) {
      console.log(
        `   Scene+color analysis failed: ${e instanceof Error ? e.message : "Unknown error"}`
      )
    }

    console.log(`   No green flash detected in first ${ANALYSIS_WINDOW}s`)
    return 0
  } catch (error) {
    console.warn(`⚠️ Green flash color analysis failed: ${error}`)
    return 0
  }
}
