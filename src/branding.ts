import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

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
        const currentDir = process.cwd()
        console.log('Current working directory:', currentDir)

        const command = (() => {
            if (custom_branding_path == null) {
                const scriptPath = path.join(currentDir, 'generate_branding.sh')
                console.log('Default branding script path:', scriptPath)
                console.log('Script exists:', fs.existsSync(scriptPath))

                return spawn(scriptPath, [botname], {
                    env: { ...process.env },
                    cwd: currentDir,
                })
            } else {
                const scriptPath = path.join(
                    currentDir,
                    'generate_custom_branding.sh',
                )
                console.log('Custom branding script path:', scriptPath)
                console.log('Script exists:', fs.existsSync(scriptPath))
                console.log('Custom branding path:', custom_branding_path)

                return spawn(scriptPath, [custom_branding_path], {
                    env: { ...process.env },
                    cwd: currentDir,
                })
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
