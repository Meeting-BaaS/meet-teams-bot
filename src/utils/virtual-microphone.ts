import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { envVars } from "../config/env-vars"
import { formatError } from "./Logger"

const run = promisify(execFile)

/** Sets this pod's PulseAudio mic mute; a muted record-only bot stays silent whatever the meeting UI shows. */
export async function setVirtualMicrophoneMuted(muted: boolean): Promise<void> {
  const targets: Array<["sink" | "source", string]> = [["sink", envVars.VIRTUAL_MIC]]
  if (process.env.PULSE_SOURCE) targets.push(["source", process.env.PULSE_SOURCE])
  for (const [kind, name] of targets) {
    try {
      await run("pactl", [`set-${kind}-mute`, name, muted ? "1" : "0"], { timeout: 5000 })
      console.log(`[VirtualMic] ${kind} ${name} muted=${muted}`)
    } catch (error) {
      console.warn(`[VirtualMic] Could not set ${kind} ${name} muted=${muted}:`, formatError(error))
    }
  }
}
