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

// Send chat message using Meet's internal API
export async function sendChatMessage(
    page: Page,
    message: string,
): Promise<boolean> {
    try {
        console.log('[NetworkInterceptor] Sending chat message via API...')

        const result = await page.evaluate(async (msg: string) => {
            try {
                // Access Meet's internal chat API
                // Google Meet exposes its API through the window object
                const meetApi = (window as any)?.APP_CONTROLLER?.getController?.()

                if (!meetApi) {
                    console.error('[NetworkInterceptor] Meet API not found')
                    return { success: false, error: 'Meet API not found' }
                }

                // Try to find the chat service/controller
                // This may vary based on Meet's internal structure
                const chatService = meetApi?.getChatController?.() ||
                                   meetApi?.chatController ||
                                   (window as any)?.__chatController

                if (!chatService) {
                    console.error('[NetworkInterceptor] Chat service not found')
                    return { success: false, error: 'Chat service not found' }
                }

                // Send the message using the internal API
                if (typeof chatService.sendMessage === 'function') {
                    await chatService.sendMessage(msg)
                    console.error('[NetworkInterceptor] ✅ Message sent via API')
                    return { success: true }
                } else if (typeof chatService.send === 'function') {
                    await chatService.send(msg)
                    console.error('[NetworkInterceptor] ✅ Message sent via API')
                    return { success: true }
                }

                console.error('[NetworkInterceptor] No send method found on chat service')
                return { success: false, error: 'No send method available' }

            } catch (e: any) {
                console.error('[NetworkInterceptor] Error sending message:', e)
                return { success: false, error: e.toString() }
            }
        }, message)

        if (result.success) {
            console.log('[NetworkInterceptor] Chat message sent successfully')
            return true
        } else {
            console.error(`[NetworkInterceptor] Failed to send chat message: ${result.error}`)
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
