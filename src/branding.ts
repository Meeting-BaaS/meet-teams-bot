import { spawn } from "node:child_process"
import fs from "node:fs"

import { VideoContext } from "./media_context"

export let brandingReady = false

const CAMERA_WARMUP_FILE = "../camera_warmup.mjpeg"

/**
 * Start streaming a pre-built black placeholder MJPEG to the v4l2 device
 * so that Google Meet sees a working camera when it probes during the join flow.
 * The placeholder is baked into the Docker image at build time with the same
 * specs as real branding output.
 */
export function warmUpCamera(): void {
  try {
    if (!fs.existsSync(CAMERA_WARMUP_FILE)) {
      console.warn("Camera warmup file not found:", CAMERA_WARMUP_FILE)
      return
    }
    const videoContext = new VideoContext()
    videoContext.play(CAMERA_WARMUP_FILE, true)
    brandingReady = true
    console.log("Camera warmed up with placeholder — v4l2 device is now streaming")
  } catch (e) {
    console.warn("Failed to warm up camera with placeholder:", e)
  }
}

/** Number of branding files successfully generated */
let brandingFileCount = 0

/** Current branding index being played */
let currentBrandingIndex = 0

/** Timer for auto loop mode */
let loopTimer: ReturnType<typeof setInterval> | null = null

export type BrandingHandle = {
  wait: Promise<void>
  kill: () => void
}

export function generateBranding(botImage: string): BrandingHandle {
  try {
    const command = (() => {
      return spawn("../generate_custom_branding.sh", [botImage], {
        env: { ...process.env }
      })
    })()
    const stdoutListener = (data: Buffer) => {
      console.log(data.toString())
    }
    const stderrListener = (data: Buffer) => {
      console.error(data.toString())
    }

    command.stdout.addListener("data", stdoutListener)
    command.stderr.addListener("data", stderrListener)

    return {
      wait: new Promise<void>((res, rej) => {
        command.on("close", (code) => {
          // Remove event listeners to prevent memory leaks
          command.stdout.removeListener("data", stdoutListener)
          command.stderr.removeListener("data", stderrListener)
          if (code === 0) {
            res()
          } else {
            rej(new Error(`Branding generation failed with exit code ${code}`))
          }
        })
      }),
      kill: () => {
        // Remove event listeners before killing the process
        command.stdout.removeListener("data", stdoutListener)
        command.stderr.removeListener("data", stderrListener)
        command.kill()
      }
    }
  } catch (e) {
    console.error("fail to generate branding ", e)
    return null
  }
}

function countBrandingFiles(): number {
  let count = 0
  while (fs.existsSync(`../branding_${count}.mjpeg`)) {
    count++
  }
  return count
}

export function playBranding() {
  try {
    brandingFileCount = countBrandingFiles()
    if (brandingFileCount === 0) {
      console.warn("No branding files found after generation, skipping playback")
      return
    }
    console.log(`Found ${brandingFileCount} branding file(s)`)

    // If VideoContext already exists (from warmUpCamera), switch to real branding.
    // Otherwise create a new one (e.g. warmUpCamera was skipped or failed).
    if (VideoContext.instance) {
      VideoContext.instance.switchTo("../branding_0.mjpeg")
    } else {
      const videoContext = new VideoContext()
      videoContext.play("../branding_0.mjpeg", true)
    }
    currentBrandingIndex = 0
    brandingReady = true
  } catch (e) {
    console.error("fail to play video branding ", e)
  }
}

/**
 * Start auto-looping through branding images at the given interval.
 * Each image switches after `imageDuration` seconds.
 */
export function startBrandingAutoLoop(imageDuration: number) {
  if (brandingFileCount <= 1) return // Nothing to loop
  if (loopTimer) return // Already looping

  console.log(
    `Starting branding auto-loop: ${imageDuration}s per image, ${brandingFileCount} images`
  )
  loopTimer = setInterval(() => {
    switchToNextBranding()
  }, imageDuration * 1000)
}

/**
 * Switch to the branding image for recording state (index 1 if available).
 * Used when loop_mode is "bot_status".
 */
export function switchToRecordingBranding() {
  if (brandingFileCount < 2) return
  switchToBrandingIndex(1)
}

function switchToNextBranding() {
  const nextIndex = (currentBrandingIndex + 1) % brandingFileCount
  switchToBrandingIndex(nextIndex)
}

function switchToBrandingIndex(index: number) {
  const file = `../branding_${index}.mjpeg`
  if (!fs.existsSync(file)) {
    console.warn(`Branding file not found: ${file}`)
    return
  }
  if (index === currentBrandingIndex) return

  console.log(`Switching branding: ${currentBrandingIndex} -> ${index}`)
  currentBrandingIndex = index
  try {
    const videoContext = VideoContext.instance
    if (videoContext) {
      videoContext.switchTo(file)
    }
  } catch (e) {
    console.error("Failed to switch branding:", e)
  }
}

export function stopBrandingLoop() {
  if (loopTimer) {
    clearInterval(loopTimer)
    loopTimer = null
  }
}
