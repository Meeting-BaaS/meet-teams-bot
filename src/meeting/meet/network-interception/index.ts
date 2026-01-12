// Network-based speaker observation for Google Meet
// Main exports and Node.js setup

import path from "node:path"
import type { Page } from "@playwright/test"
import { browserInterceptionLogic } from "./browser-bundle"
import { PROTO_SCHEMA } from "./schema"

// Re-export types
export type { ChatMessage, NetworkPayload, NetworkUser } from "./types"

// Extend Window interface for network interception functions
declare global {
  interface Window {
    _sendChatMessage?: (messageText: string) => Promise<boolean>
    __networkInterceptorMain?: boolean
    protobuf?: unknown
    pako?: unknown
    onNetworkSpeakerUpdate?: (payload: {
      users: unknown[]
      timestamp: number
      source: string
    }) => void
    triggerNetworkBroadcast?: () => void
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
    console.error(
      "[NetworkInterceptor] ❌ Failed to load libraries bundle:",
      error
    )
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
    console.error(
      "[NetworkInterceptor] ❌ Failed to inject browser logic:",
      error
    )
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
 * Setup network interception callback (can be called AFTER page.goto())
 * This exposes the callback function that receives speaker updates
 */
export async function setupNetworkInterceptionCallback(
  page: Page,
  onSpeakersChange: (payload: {
    users: unknown[]
    timestamp: number
    source: string
  }) => void
): Promise<boolean> {
  try {
    // Expose the Node-side callback to the browser via Playwright's exposeFunction
    // When browser-bundle.ts calls window.onNetworkSpeakerUpdate(), it crosses to Node-side
    await page.exposeFunction("onNetworkSpeakerUpdate", onSpeakersChange)
    console.log("[NetworkInterceptor] ✅ Callback exposed")
    return true
  } catch (error) {
    console.error(
      "[NetworkInterceptor] Failed to expose function:",
      error
    )
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
  onSpeakersChange: (payload: {
    users: unknown[]
    timestamp: number
    source: string
  }) => void
): Promise<boolean> {
  const scriptsSuccess = await setupNetworkInterceptionScripts(page)
  if (!scriptsSuccess) {
    return false
  }

  return setupNetworkInterceptionCallback(page, onSpeakersChange)
}

// Send chat message using network/data channel (protobuf approach)
export async function sendChatMessage(
  page: Page,
  message: string
): Promise<boolean> {
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
    } else {
      console.error(
        "[NetworkInterceptor] ❌ Failed to send chat message via network"
      )
      return false
    }
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
