// Network-based speaker observation for Google Meet
// Main exports and Node.js setup

import * as fs from 'fs'
import { Page } from 'playwright'
import { browserInterceptionLogic } from './browser'
import { PROTO_SCHEMA } from './schema'

// Re-export types
export type { ChatMessage, NetworkPayload, NetworkUser } from './types'

// Main setup function
export async function enableNetworkInterception(
    page: Page,
    onSpeakersChange: (payload: {
        users: any[]
        timestamp: number
        source: string
    }) => void,
): Promise<void> {
    await page.exposeFunction('onNetworkSpeakerUpdate', onSpeakersChange)

    await page.addInitScript(() => {
        ;(window as any)._updateNetworkCallback = () => {
            if ((window as any).triggerNetworkBroadcast)
                (window as any).triggerNetworkBroadcast()
        }
    })

    let libs = ''
    try {
        libs += fs.readFileSync(
            require.resolve('protobufjs/dist/protobuf.min.js'),
            'utf8',
        )
        libs += fs.readFileSync(
            require.resolve('pako/dist/pako.min.js'),
            'utf8',
        )
    } catch {
        return
    }

    const script = `
        (function() {
            try {
                window.__networkInterceptorMain = true;
                ${libs}
                if (typeof window !== 'undefined') {
                    window.protobuf = window.protobuf || window.protobufjs;
                    window.pako = window.pako;
                }
                if (!window.protobuf || !window.pako) return;
                
                (${browserInterceptionLogic.toString()})(${JSON.stringify(PROTO_SCHEMA)});
            } catch (e) { console.error(e); }
        })();
    `

    try {
        await page.addInitScript(script)
    } catch {}
}

// Verification function
export async function verifyNetworkInterception(page: Page): Promise<boolean> {
    try {
        const status = await page.evaluate(() => {
            return {
                hasInterceptor:
                    typeof (window as any).__networkInterceptorMain !==
                    'undefined',
                hasProtobuf: typeof (window as any).protobuf !== 'undefined',
                hasPako: typeof (window as any).pako !== 'undefined',
                hasCallback:
                    typeof (window as any).onNetworkSpeakerUpdate !==
                    'undefined',
                canTrigger:
                    typeof (window as any).triggerNetworkBroadcast !==
                    'undefined',
            }
        })

        console.error('[NetworkInterceptor] Status:', status)

        if (!status.hasInterceptor) {
            console.error('[NetworkInterceptor] ❌ Main interceptor not loaded')
            return false
        }

        if (!status.hasProtobuf || !status.hasPako) {
            console.error('[NetworkInterceptor] ❌ Dependencies missing')
            return false
        }

        if (!status.hasCallback) {
            console.warn(
                '[NetworkInterceptor] ⚠️ Callback not registered yet (expected early in lifecycle)',
            )
        }

        return true
    } catch (e) {
        console.error('[NetworkInterceptor] ❌ Verification failed:', e)
        return false
    }
}
