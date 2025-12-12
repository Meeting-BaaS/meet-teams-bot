// Network-based speaker observation for Google Meet
// Main exports and Node.js setup

import * as path from 'path'
import { Page } from '@playwright/test'
import { browserInterceptionLogic } from './browser-bundle'
import { PROTO_SCHEMA } from './schema'

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
): Promise<boolean> {
    try {
        // Expose the Node-side callback function that the browser can call
        // The actual callback update mechanism is handled via _setNodeNetworkCallback
        // which directly calls window.triggerNetworkBroadcast() in the browser
        await page.exposeFunction('onNetworkSpeakerUpdate', onSpeakersChange)
    } catch (error) {
        console.error(
            '[NetworkInterceptor] Failed to expose function:',
            error,
        )
        console.error('Stack:', (error as Error).stack)
        return false
    }

    // Load heavy dependencies (protobufjs + pako) from pre-built bundle file
    // This avoids massive inline string concatenation (~250KB)
    try {
        const bundlePath = path.resolve(__dirname, 'bundle/network-interceptor-libs.bundle.js')
        await page.addInitScript({ path: bundlePath })
        console.log('[NetworkInterceptor] ✅ Libraries bundle loaded from file')
    } catch (error) {
        console.error(
            '[NetworkInterceptor] ❌ Failed to load libraries bundle:',
            error,
        )
        console.error('Stack:', (error as Error).stack)
        return false
    }

    // Inject browser logic (much smaller now ~30KB)
    // This remains inline so it can receive PROTO_SCHEMA dynamically
    const script = `
        (function() {
            try {
                window.__networkInterceptorMain = true;

                // Dependencies (protobuf + pako) are already loaded from bundle file
                if (!window.protobuf || !window.pako) {
                    console.error('[NetworkInterceptor] Dependencies not loaded');
                    return;
                }

                // Execute browser interception logic with schema
                (${browserInterceptionLogic.toString()})(${JSON.stringify(PROTO_SCHEMA)});
            } catch (e) {
                console.error('[NetworkInterceptor] Initialization error:', e);
            }
        })();
    `

    // Inject the browser logic script (small, dynamic)
    try {
        await page.addInitScript(script)
        console.log('[NetworkInterceptor] ✅ Browser logic injected')
        return true
    } catch (error) {
        console.error(
            '[NetworkInterceptor] ❌ Failed to inject browser logic:',
            error,
        )
        console.error('Error details:', {
            name: (error as Error).name,
            message: (error as Error).message,
            stack: (error as Error).stack,
        })
        // Return false to allow graceful degradation
        return false
    }
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
