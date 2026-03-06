import { spawn } from "node:child_process"
import fs from "node:fs"

import { VideoContext } from "./media_context"

export let brandingReady = false

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

export function playBranding() {
  try {
    if (!fs.existsSync("../branding.mjpeg")) {
      console.warn("Branding file not found after generation, skipping playback")
      return
    }
    const videoContext = new VideoContext()
    videoContext.default()
    brandingReady = true
  } catch (e) {
    console.error("fail to play video branding ", e)
  }
}
