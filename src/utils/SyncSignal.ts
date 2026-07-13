/**
 * Utility function to generate audio-visual sync signal for recordings
 * Generates a 1000Hz beep + green flash for synchronization purposes
 */

import type { Page } from "@playwright/test"
import { formatError } from "./Logger"

// Extend Window interface for sync audio context
declare global {
  interface Window {
    __syncAudioContext?: AudioContext
    webkitAudioContext?: typeof AudioContext
  }
}

interface SyncSignalOptions {
  /** Duration of the sync signal in milliseconds (default: 500) */
  duration?: number
  /** Audio frequency in Hz (default: 1000) */
  frequency?: number
  /** Flash color (default: '#00FF00' - bright green) */
  flashColor?: string
  /** Audio volume (0-1, default: 0.9) */
  volume?: number
}

/**
 * Generate synchronization signal on the given page
 * @param page - Playwright page instance
 * @param options - Optional configuration for the sync signal
 */
export interface SyncSignalTimestamps {
  /** Wall-clock ms when the WebAudio oscillator actually started. Null if unmeasured. */
  audioBeepWallMs: number | null
  /** Wall-clock ms when the flash paint committed (post-rAF). Null if unmeasured. */
  videoFlashWallMs: number | null
}

/**
 * Generate synchronization signal on the given page.
 *
 * Returns per-signal wall-clock emission timestamps: both signals ride the
 * page.evaluate queue of a Chromium that is busy joining the meeting, and that
 * queue has been measured delaying execution by up to ~3.9s under multi-bot
 * node load. Anchoring each detection window on its own signal's real emission
 * time — and subtracting the emission gap in the offset math — isolates pure
 * capture-start skew from evaluate/paint delays.
 */
export async function generateSyncSignal(
  page: Page,
  options: SyncSignalOptions = {}
): Promise<SyncSignalTimestamps> {
  const { duration = 150, frequency = 1000, flashColor = "#00FF00", volume = 0.9 } = options

  console.log(`🎯 Generating sync signal: ${frequency}Hz beep + flash (${duration}ms)`)

  try {
    // Generate audio beep and visual flash simultaneously
    const [audioBeepWallMs, videoFlashWallMs] = await Promise.all([
      generateAudioBeep(page, frequency, duration, volume),
      generateVisualFlash(page, flashColor, duration)
    ])

    console.log(
      `✅ Sync signal generated successfully (beep wall=${audioBeepWallMs ?? "n/a"}, flash paint wall=${videoFlashWallMs ?? "n/a"})`
    )
    return { audioBeepWallMs, videoFlashWallMs }
  } catch (error) {
    console.error("❌ Failed to generate sync signal:", formatError(error))
    throw error
  }
}

/**
 * Generate audio beep in the browser
 */
async function generateAudioBeep(
  page: Page,
  frequency: number,
  duration: number,
  volume: number
): Promise<number | null> {
  try {
    // Returns the wall-clock ms at which the oscillator started (the page
    // clock and Node's Date.now() are the same machine clock). Null when the
    // beep was skipped or failed.
    const oscillatorStartWallMs: number | null = await page.evaluate(
      ({ freq, dur, vol }) => {
        if (window.__syncAudioContext) {
          console.log("⚠️ AudioContext already exists, skipping duplicate beep")
          return null
        }

        try {
          const audioContext = new (window.AudioContext || window.webkitAudioContext)()

          window.__syncAudioContext = audioContext

          const oscillator = audioContext.createOscillator()
          const gainNode = audioContext.createGain()

          oscillator.connect(gainNode)
          gainNode.connect(audioContext.destination)

          oscillator.frequency.setValueAtTime(freq, audioContext.currentTime)
          oscillator.type = "sine"

          const durationSec = dur / 1000
          gainNode.gain.setValueAtTime(0, audioContext.currentTime)
          gainNode.gain.setValueAtTime(vol, audioContext.currentTime + 0.005)
          gainNode.gain.setValueAtTime(vol, audioContext.currentTime + durationSec - 0.005)
          gainNode.gain.setValueAtTime(0, audioContext.currentTime + durationSec)

          oscillator.start(audioContext.currentTime)
          const startWallMs = Date.now()
          oscillator.stop(audioContext.currentTime + durationSec)

          setTimeout(() => {
            try {
              audioContext.close()
              delete window.__syncAudioContext
            } catch (e) {
              console.warn("AudioContext cleanup warning:", e)
            }
          }, dur + 100)

          console.log(`🔊 Audio beep: ${freq}Hz for ${dur}ms at volume ${vol}`)
          return startWallMs
        } catch (error) {
          console.error("Audio beep error:", error)
          delete window.__syncAudioContext
          return null
        }
      },
      { freq: frequency, dur: duration, vol: volume }
    )
    return oscillatorStartWallMs
  } catch (error) {
    console.warn("⚠️ Audio beep timestamp unavailable:", formatError(error))
    return null
  }
}

/**
 * Generate visual flash overlay
 */
async function generateVisualFlash(
  page: Page,
  color: string,
  duration: number
): Promise<number | null> {
  try {
    // Returns the wall-clock ms at which the flash paint was committed (after
    // two animation frames: the first fires before the frame containing the
    // overlay is composited, the second after it is on screen).
    const paintWallMs: number | null = await page.evaluate(
      ({ flashColor, dur }) => {
        if (document.querySelector("#sync-flash-overlay")) {
          console.log("⚠️ Flash overlay already exists, skipping duplicate")
          return null
        }

        const flashDiv = document.createElement("div")
        flashDiv.id = "sync-flash-overlay"
        flashDiv.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: ${flashColor};
            z-index: 999999;
            pointer-events: none;
            box-shadow: inset 0 0 30px ${flashColor};
            opacity: 1;
        `

        document.body.appendChild(flashDiv)
        console.log(`💡 Visual flash: ${flashColor} for ${dur}ms`)

        setTimeout(() => {
          flashDiv.remove()
        }, dur)

        return new Promise<number>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve(Date.now())
            })
          })
        })
      },
      { flashColor: color, dur: duration }
    )
    return paintWallMs
  } catch (error) {
    console.warn("⚠️ Visual flash paint timestamp unavailable:", formatError(error))
    return null
  }
}
