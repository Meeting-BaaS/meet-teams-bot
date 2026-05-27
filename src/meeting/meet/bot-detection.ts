import type { Page } from '@playwright/test'
import protobuf from 'protobufjs'

// Node-side reflection for the single field we read off Meet's
// CreateMeetingDeviceResponse. protobufjs Type.decode skips unknown fields
// automatically, so we don't have to spell out the rest of the message —
// the full proto has dozens of fields we don't care about.
const CreateMeetingDeviceResponseType = new protobuf.Type(
    'CreateMeetingDeviceResponse',
).add(new protobuf.Field('detectedAsBot', 36, 'uint32'))

// Signal payload emitted when Meet's CreateMeetingDevice response is decoded.
// Field 36 of the response is a varint that's set when Meet has classified
// the bot as suspected.
export type MeetBotDetectionSignal = {
    detectedAsBot: boolean
    rawField: number | string | null
    timestamp: number
}

/**
 * Setup the Meet bot-detection signal observer. Must be called BEFORE
 * page.goto() so the response listener is in place when the first
 * CreateMeetingDevice request fires during the join handshake.
 *
 * Uses page.on("response", ...) as a passive observer — fires after the
 * browser has fully received the response and lets us read the body from
 * Playwright's buffer. The request itself is never touched: Chrome's TLS
 * handshake, HTTP/2 settings, header order all stay genuine.
 *
 * History: an earlier approach used page.route() + route.fetch() +
 * route.fulfill(). That worked for capturing the signal but caused Meet to
 * flag the bot because route.fetch() re-issues the request from Node's HTTP
 * stack (page.request context), producing a node-fetch JA3/JA4 fingerprint
 * that doesn't match Chrome. Two consecutive runs returned detectedAsBot=2
 * because of this. Pure observation has no such side-effect.
 */
export async function setupBotDetectionRoute(
    page: Page,
    onSignal: (signal: MeetBotDetectionSignal) => void,
): Promise<boolean> {
    page.on('response', async (response) => {
        try {
            const url = response.url()
            if (!url.includes('MeetingDeviceService/CreateMeetingDevice')) {
                return
            }
            if (!response.ok()) return
            const text = await response.text()
            // Response body is base64-encoded protobuf.
            const bytes = Uint8Array.from(Buffer.from(text, 'base64'))
            const raw = decodeDetectedAsBotField(bytes)
            onSignal({
                detectedAsBot: Boolean(raw),
                rawField: raw,
                timestamp: Date.now(),
            })
        } catch (err) {
            // Body might not be available (e.g. response stream already consumed
            // by Meet's own JS reading it twice via clone) or decode could fail.
            // Don't break the join flow over a telemetry hiccup.
            console.error('[BotDetection] response handler failed:', err)
        }
    })
    console.log(
        "[BotDetection] ✅ page.on('response') observer installed for CreateMeetingDevice",
    )
    return true
}

function decodeDetectedAsBotField(bytes: Uint8Array): number | null {
    try {
        const msg = CreateMeetingDeviceResponseType.decode(
            bytes,
        ) as unknown as { detectedAsBot?: number }
        return msg.detectedAsBot ?? null
    } catch {
        return null
    }
}
