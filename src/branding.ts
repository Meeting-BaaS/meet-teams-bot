import { spawn } from 'child_process'

import { VideoContext } from './media_context'

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
                return spawn('./generate_branding.sh', [botname], {
                    env: { ...process.env },
                    cwd: process.cwd(),
                })
            } else {
                return spawn(
                    './generate_custom_branding.sh',
                    [custom_branding_path],
                    { env: { ...process.env }, cwd: process.cwd() },
                )
            }
        })()
        command.stderr.addListener('data', (data) => {
            console.log(data.toString())
        })

        return {
            wait: new Promise<void>((res) => {
                command.on('close', () => {
                    res()
                })
            }),
            kill: () => {
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
