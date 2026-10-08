import { execFile } from 'child_process'
import { promisify } from 'util'
import { formatError } from './Logger'

const run = promisify(execFile)

/** Mute the pod's input devices before the browser can open its microphone. */
export async function setVirtualMicrophoneMuted(muted: boolean): Promise<void> {
    const targets: Array<['sink' | 'source', string | undefined]> = [
        ['sink', process.env.VIRTUAL_MIC],
        ['source', process.env.PULSE_SOURCE],
    ]
    for (const [kind, name] of targets) {
        if (!name) continue
        try {
            await run('pactl', [`set-${kind}-mute`, name, muted ? '1' : '0'], {
                timeout: 5000,
            })
        } catch (error) {
            console.warn(
                `[VirtualMic] Could not set ${kind} mute:`,
                formatError(error),
            )
        }
    }
}
