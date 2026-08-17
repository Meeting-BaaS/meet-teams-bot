// Network-based speaker observation for Google Meet
// Main exports and Node.js setup

import path from "node:path"
import type { Page } from "@playwright/test"
import protobuf from "protobufjs"
import { browserInterceptionLogic } from "./browser-bundle"
import { decodeDcrpcFrame } from "./dcrpc-decoder"
import { PROTO_SCHEMA } from "./schema"

// Node-side reflection for the single field we read off Meet's
// CreateMeetingDeviceResponse. protobufjs Type.decode skips unknown fields
// automatically, so we don't have to spell out the rest of the message —
// the full proto has dozens of fields we don't care about.
const CreateMeetingDeviceResponseType = new protobuf.Type("CreateMeetingDeviceResponse").add(
  new protobuf.Field("detectedAsBot", 36, "uint32")
)

// Re-export types
export type { ChatMessage, NetworkPayload, NetworkUser } from "./types"

import type { ChatMessage, NetworkPayload } from "./types"

// Signal payload emitted when Meet's CreateMeetingDevice response is decoded.
// Field 36 of the response is a varint that's set when Meet has classified
// the bot as suspected.
export type MeetBotDetectionSignal = {
  detectedAsBot: boolean
  decoded: boolean
  rawField: number | string | null
  timestamp: number
}

// Extend Window interface for network interception functions
declare global {
  interface Window {
    _sendChatMessage?: (messageText: string) => Promise<boolean>
    __networkInterceptorMain?: boolean
    protobuf?: unknown
    pako?: unknown
    __decodeDcrpcFrame?: (
      frame: Uint8Array,
      inflate: (bytes: Uint8Array) => Uint8Array
    ) => Array<{ deviceId: string; speaking: boolean }> | null
    onNetworkSpeakerUpdate?: (payload: {
      users: unknown[]
      timestamp: number
      source: string
    }) => void
    onChatMessageReceived?: (message: ChatMessage) => void
    triggerNetworkBroadcast?: () => void
    __stopNetworkInterception?: () => void
  }
}

/**
 * Setup network interception scripts (must be called BEFORE page.goto())
 * This adds the init scripts that will run when the page loads
 */
export async function setupNetworkInterceptionScripts(page: Page): Promise<boolean> {
  try {
    // Load heavy dependencies (protobufjs + pako) from pre-built bundle file
    // This avoids massive inline string concatenation (~250KB)
    const bundlePath = path.resolve(__dirname, "bundle/network-interceptor-libs.bundle.js")
    await page.addInitScript({ path: bundlePath })
    console.log("[NetworkInterceptor] ✅ Libraries bundle loaded from file")
  } catch (error) {
    console.error("[NetworkInterceptor] ❌ Failed to load libraries bundle:", error)
    console.error("Stack:", (error as Error).stack)
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
                    console.error("[NetworkInterceptor] Dependencies not loaded");
                    return;
                }

                // Expose the dcrpc speaker decoder in the page scope. It is a
                // self-contained function (no imports/closures), so stringifying
                // it here keeps a single implementation shared with the Node
                // unit test.
                window.__decodeDcrpcFrame = (${decodeDcrpcFrame.toString()});

                // Execute browser interception logic with schema
                (${browserInterceptionLogic.toString()})(${JSON.stringify(PROTO_SCHEMA)});
            } catch (e) {
                console.error("[NetworkInterceptor] Initialization error:", e);
            }
        })();
    `

  // Inject the browser logic script (small, dynamic)
  try {
    await page.addInitScript(script)
    console.log("[NetworkInterceptor] ✅ Browser logic injected")
    return true
  } catch (error) {
    console.error("[NetworkInterceptor] ❌ Failed to inject browser logic:", error)
    console.error("Error details:", {
      name: (error as Error).name,
      message: (error as Error).message,
      stack: (error as Error).stack
    })
    // Return false to allow graceful degradation
    return false
  }
}

/**
 * Force the Meet client onto its native WebRTC inbound-audio media path
 * (A/B experiment, gated by MEET_FORCE_NATIVE_AUDIO_PIPELINE).
 *
 * Must be called BEFORE page.goto() — like the other interception init scripts,
 * this runs on every navigation before the Meet client's own page JS, which is
 * the only point at which the feature-detection can be intercepted.
 *
 * The Meet client feature-detects RTCRtpReceiver.prototype.createEncodedStreams
 * to choose which inbound-audio media path to use. When it is present the client
 * selects an encoded/insertable-streams path: audio is decoded by an AudioWorklet
 * and mixed into a single MediaStreamAudioDestination track that carries no
 * RTCRtpReceiver, so RTCRtpReceiver.getContributingSources() — our per-participant
 * (CSRC + audioLevel) speaker attribution — has nothing to read and diarization
 * collapses to the DOM UI observer. When createEncodedStreams is absent the client
 * falls back to the native WebRTC media path, where the SFU's small fixed pool of
 * recvonly audio tracks each expose a live RTCRtpReceiver whose
 * getContributingSources() reports the active participant per slot.
 *
 * Deleting createEncodedStreams from the receiver prototype before the client
 * runs therefore forces the native path so the existing getContributingSources /
 * CSRC attribution (see setupRTCRtpReceiverInterceptor + the CSRC sampler in
 * browser-bundle.ts) receives per-participant tracks. It does not remove or
 * disable the datachannel/AudioWorklet fallback path — that path is driven by the
 * Meet client's own choice, so forcing native simply leaves it dormant rather
 * than breaking it.
 */
export async function setupForceNativeAudioPipeline(page: Page): Promise<boolean> {
  const script = `
        (function() {
            try {
                var proto = window.RTCRtpReceiver && window.RTCRtpReceiver.prototype;
                if (!proto) {
                    console.error("[ForceNativeAudio] RTCRtpReceiver.prototype unavailable; cannot force native audio pipeline");
                    return;
                }
                var removed = [];
                var failed = [];
                // Record a name as removed only if the delete actually took AND the
                // property is no longer resolvable on proto (covers non-configurable
                // own props where delete returns false, and inherited props that
                // survive on the prototype chain). Otherwise the native path was NOT
                // forced and the log must say so rather than claim a false success.
                function hide(name) {
                    if (!(name in proto)) return;
                    try {
                        if (Reflect.deleteProperty(proto, name) && !(name in proto)) {
                            removed.push(name);
                        } else {
                            failed.push(name);
                        }
                    } catch (e) {
                        failed.push(name);
                    }
                }
                hide("createEncodedStreams");
                // webkit-prefixed variant, present on some builds.
                hide("webkitCreateEncodedStreams");
                var msg = "[ForceNativeAudio] createEncodedStreams support on RTCRtpReceiver.prototype (removed: " + (removed.join(", ") || "none present") + (failed.length ? "; FAILED to hide: " + failed.join(", ") : "") + ") — forcing native WebRTC inbound-audio path for per-participant speaker attribution";
                if (failed.length) { console.error(msg); } else { console.log(msg); }
            } catch (e) {
                console.error("[ForceNativeAudio] Failed to hide createEncodedStreams:", e);
            }
        })();
    `
  try {
    await page.addInitScript(script)
    console.log(
      "[ForceNativeAudio] ✅ Native-audio-pipeline init script injected (MEET_FORCE_NATIVE_AUDIO_PIPELINE=true)"
    )
    return true
  } catch (error) {
    console.error("[ForceNativeAudio] ❌ Failed to inject native-audio-pipeline init script:", error)
    return false
  }
}

/**
 * Setup network interception callback (can be called AFTER page.goto())
 * This exposes the callback function that receives speaker updates
 */
export async function setupNetworkInterceptionCallback(
  page: Page,
  onSpeakersChange: (payload: NetworkPayload) => void
): Promise<boolean> {
  try {
    // Expose the Node-side callback to the browser via Playwright's exposeFunction
    // When browser-bundle.ts calls window.onNetworkSpeakerUpdate(), it crosses to Node-side
    await page.exposeFunction("onNetworkSpeakerUpdate", onSpeakersChange)
    console.log("[NetworkInterceptor] ✅ Callback exposed")
    return true
  } catch (error) {
    console.error("[NetworkInterceptor] Failed to expose function:", error)
    console.error("Stack:", (error as Error).stack)
    return false
  }
}

/**
 * Main setup function (convenience wrapper)
 * NOTE: This should NOT be used if you need to call addInitScript before page.goto()
 * Use setupNetworkInterceptionScripts() and setupNetworkInterceptionCallback() separately instead
 */
export async function enableNetworkInterception(
  page: Page,
  onSpeakersChange: (payload: NetworkPayload) => void
): Promise<boolean> {
  const scriptsSuccess = await setupNetworkInterceptionScripts(page)
  if (!scriptsSuccess) {
    return false
  }

  return setupNetworkInterceptionCallback(page, onSpeakersChange)
}

/**
 * Setup chat message callback (can be called AFTER page.goto())
 * Exposes onChatMessageReceived to the browser so the datachannel handler can call back to Node.js
 */
export async function setupChatMessageCallback(
  page: Page,
  onChatMessage: (msg: ChatMessage) => void
): Promise<boolean> {
  try {
    await page.exposeFunction("onChatMessageReceived", onChatMessage)
    console.log("[NetworkInterceptor] ✅ Chat message callback exposed")
    return true
  } catch (error) {
    console.error("[NetworkInterceptor] Failed to expose chat callback:", error)
    return false
  }
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
 * History: the previous implementation used page.route() + route.fetch() +
 * route.fulfill(). That worked for capturing the signal but caused Meet to
 * flag the bot because route.fetch() re-issues the request from Node's HTTP
 * stack (page.request context), producing a node-fetch JA3/JA4 fingerprint
 * that doesn't match Chrome. Two consecutive runs returned detectedAsBot=2
 * because of this. Pure observation has no such side-effect.
 *
 * page.on("response") is dispatched via the Network CDP domain, not Runtime,
 * so rebrowser-playwright's Runtime.enable patch doesn't suppress it (the
 * same reason page.on("request") still works under rebrowser).
 */
export async function setupBotDetectionRoute(
  page: Page,
  onSignal: (signal: MeetBotDetectionSignal) => void
): Promise<boolean> {
  page.on("response", async (response) => {
    try {
      const url = response.url()
      if (!url.includes("MeetingDeviceService/CreateMeetingDevice")) return
      if (!response.ok()) return
      const text = await response.text()
      // Response body is base64-encoded protobuf.
      const bytes = Uint8Array.from(Buffer.from(text, "base64"))
      const decoded = decodeDetectedAsBotField(bytes)
      onSignal({
        detectedAsBot: decoded.decoded && Boolean(decoded.rawField),
        decoded: decoded.decoded,
        rawField: decoded.rawField,
        timestamp: Date.now()
      })
    } catch (err) {
      // Body might not be available (e.g. response stream already consumed
      // by Meet's own JS reading it twice via clone) or decode could fail.
      // Don't break the join flow over a telemetry hiccup.
      console.error("[BotDetection] response handler failed:", err)
    }
  })
  console.log("[BotDetection] ✅ page.on('response') observer installed for CreateMeetingDevice")
  return true
}

function decodeDetectedAsBotField(bytes: Uint8Array): {
  decoded: boolean
  rawField: number | null
} {
  try {
    const msg = CreateMeetingDeviceResponseType.decode(bytes) as unknown as {
      detectedAsBot?: number
    }
    return { decoded: true, rawField: msg.detectedAsBot ?? null }
  } catch {
    return { decoded: false, rawField: null }
  }
}

// Send chat message using network/data channel (protobuf approach)
export async function sendChatMessage(page: Page, message: string): Promise<boolean> {
  try {
    console.log("[NetworkInterceptor] Sending chat message via network...")

    const result = await page.evaluate(async (msg: string) => {
      if (window._sendChatMessage) {
        // The function is now async, so await it
        return await window._sendChatMessage(msg)
      }
      return false
    }, message)

    if (result) {
      console.log("[NetworkInterceptor] ✅ Chat message sent via network")
      return true
    }
    console.error("[NetworkInterceptor] ❌ Failed to send chat message via network")
    return false
  } catch (e) {
    console.error("[NetworkInterceptor] Exception sending chat message:", e)
    return false
  }
}

// Verification function
export async function verifyNetworkInterception(page: Page): Promise<boolean> {
  try {
    const status = await page.evaluate(() => {
      return {
        hasInterceptor: typeof window.__networkInterceptorMain !== "undefined",
        hasProtobuf: typeof window.protobuf !== "undefined",
        hasPako: typeof window.pako !== "undefined",
        hasCallback: typeof window.onNetworkSpeakerUpdate !== "undefined",
        canTrigger: typeof window.triggerNetworkBroadcast !== "undefined"
      }
    })

    console.log("[NetworkInterceptor] Status:", status)

    if (!status.hasInterceptor) {
      console.error("[NetworkInterceptor] ❌ Main interceptor not loaded")
      return false
    }

    if (!status.hasProtobuf || !status.hasPako) {
      console.error("[NetworkInterceptor] ❌ Dependencies missing")
      return false
    }

    if (!status.hasCallback) {
      console.warn(
        "[NetworkInterceptor] ⚠️ Callback not registered yet (expected early in lifecycle)"
      )
    }

    return true
  } catch (e) {
    console.error("[NetworkInterceptor] ❌ Verification failed:", e)
    return false
  }
}

/**
 * Stop network interception by aborting all tracks and preventing further callbacks
 */
export async function stopNetworkInterception(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      if (typeof window.__stopNetworkInterception === "function") {
        window.__stopNetworkInterception()
      } else {
        console.warn("[NetworkInterceptor] ⚠️ Stop function not available")
      }
    })
    console.log("[NetworkInterceptor] ✅ Network interception stopped")
  } catch (error) {
    console.error("[NetworkInterceptor] ❌ Failed to stop network interception:", error)
  }
}
