import { spawn } from 'child_process'

import { SoundContext, VideoContext } from './media_context'

export type BrandingHandle = {
    wait: Promise<void>
    kill: () => void
}

export function generateBranding(
    botname: string,
    custom_branding_path?: string,
): BrandingHandle {
    try {
        const command = (() => {
            if (custom_branding_path == null) {
                return spawn('../generate_branding.sh', [botname], {
                    env: { ...process.env },
                })
            } else {
                return spawn(
                    '../generate_custom_branding.sh',
                    [custom_branding_path],
                    { env: { ...process.env } },
                )
            }
        })()
        const stdoutListener = (data: Buffer) => {
            console.log(data.toString())
        }
        const stderrListener = (data: Buffer) => {
            console.error(data.toString())
        }

        command.stdout.addListener('data', stdoutListener)
        command.stderr.addListener('data', stderrListener)

        return {
            wait: new Promise<void>((res) => {
                // spawn emits 'error' ASYNCHRONOUSLY (e.g. ENOENT when the
                // script is missing, as in local builds that don't ship
                // generate_custom_branding.sh). Without a listener that becomes
                // an uncaught exception at browser launch. Handle it here so
                // branding just degrades (no camera image) instead of
                // destabilising the whole bot.
                command.on('error', (err) => {
                    command.stdout?.removeListener('data', stdoutListener)
                    command.stderr?.removeListener('data', stderrListener)
                    console.warn(
                        '[Branding] generate_custom_branding.sh could not be spawned — branding skipped:',
                        err instanceof Error ? err.message : String(err),
                    )
                    res()
                })
                command.on('close', () => {
                    // Remove event listeners to prevent memory leaks
                    command.stdout.removeListener('data', stdoutListener)
                    command.stderr.removeListener('data', stderrListener)
                    res()
                })
            }),
            kill: () => {
                // Remove event listeners before killing the process
                command.stdout.removeListener('data', stdoutListener)
                command.stderr.removeListener('data', stderrListener)
                command.kill()
            },
        }
    } catch (e) {
        console.error('fail to generate branding ', e)
        return null
    }
}

export function playBranding() {
    try {
        new VideoContext(0)
        VideoContext.instance.default()
    } catch (e) {
        console.error('fail to play video branding ', e)
    }
}
