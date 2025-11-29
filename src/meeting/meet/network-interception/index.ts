// Network-based speaker observation for Google Meet
// Main exports and Node.js setup

import * as fs from 'fs'
import { Page } from '@playwright/test'
import { browserInterceptionLogic } from './browser-bundle'
import { PROTO_SCHEMA } from './schema'
import { Streaming } from '../../../streaming'

// Re-export types
export type { ChatMessage, NetworkPayload, NetworkUser } from './types'

// Main setup function
export async function enableNetworkInterception(
    page: Page,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onSpeakersChange: (payload: {
        users: any[]
        timestamp: number
        source: string
    }) => void,
): Promise<void> {
    await page.exposeFunction('onNetworkSpeakerUpdate', onSpeakersChange)

    // Expose function for ultra-low latency audio streaming from browser (per-track for analysis)
    await page.exposeFunction('onBrowserAudioChunk', async (audioChunk: {
        audioData: number[]
        sampleRate: number
        timestamp: number
        numberOfFrames: number
        ssrc: any
        deviceId: string | null
        userName: string | null
    }) => {
        // Forward to Streaming instance for analysis/logging only
        if (Streaming.instance) {
            try {
                Streaming.instance.processBrowserAudioChunk(audioChunk)
            } catch (error) {
                console.error('[NetworkInterceptor] Failed to process browser audio chunk:', error)
            }
        }
    })

    // Expose function for pre-mixed audio from Web Audio API (KISS approach!)
    await page.exposeFunction('onBrowserMixedAudioChunk', async (audioChunk: {
        audioData: number[]
        sampleRate: number
        timestamp: number
        numberOfFrames: number
    }) => {
        // Forward pre-mixed audio directly to streaming (no manual mixing needed!)
        if (Streaming.instance) {
            try {
                Streaming.instance.processMixedAudioChunk(audioChunk)
            } catch (error) {
                console.error('[NetworkInterceptor] Failed to process mixed audio chunk:', error)
            }
        }
    })

    await page.addInitScript(() => {
        ; (window as any)._updateNetworkCallback = () => {
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
    } catch { }
}

// Send chat message using network/data channel (protobuf approach)
export async function sendChatMessage(
    page: Page,
    message: string,
): Promise<boolean> {
    try {
        console.log('[NetworkInterceptor] Sending chat message via network...')

        const result = await page.evaluate(async (msg: string) => {
            if ((window as any)._sendChatMessage) {
                // The function is now async, so await it
                return await (window as any)._sendChatMessage(msg)
            }
            return false
        }, message)

        if (result) {
            console.log('[NetworkInterceptor] ✅ Chat message sent via network')
            return true
        } else {
            console.error(
                '[NetworkInterceptor] ❌ Failed to send chat message via network',
            )
            return false
        }
    } catch (e) {
        console.error('[NetworkInterceptor] Exception sending chat message:', e)
        return false
    }
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
