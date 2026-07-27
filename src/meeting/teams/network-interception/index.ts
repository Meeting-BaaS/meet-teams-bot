// Network-based speaker observation for Microsoft Teams.
// Node.js setup + browser/Node bridge.

import type { Page } from "@playwright/test"
import { teamsBrowserInterceptionLogic } from "./browser-bundle"

export type { NetworkPayload, NetworkUser } from "./types"
import type { NetworkPayload } from "./types"

declare global {
  interface Window {
    __teamsNetworkInterceptorMain?: boolean
    __teamsNetworkInterceptorInitialized?: boolean
    __teamsStopNetworkInterception?: () => void
    __teamsNetworkBroadcastNow?: () => void
    onNetworkSpeakerUpdate?: (payload: NetworkPayload) => void
    pako?: unknown
  }
}

/**
 * Inject interception scripts; must run BEFORE page.goto() (addInitScript only
 * applies to later navigations).
 */
export async function setupTeamsNetworkInterceptionScripts(page: Page): Promise<boolean> {
  try {
    const pakoPath = require.resolve("pako/dist/pako.min.js")
    await page.addInitScript({ path: pakoPath })
    console.log("[Teams NetworkInterceptor] ✅ pako loaded from file")
  } catch (error) {
    console.error("[Teams NetworkInterceptor] ❌ Failed to load pako:", error)
    return false
  }

  const script = `
        (function() {
            try {
                window.__teamsNetworkInterceptorMain = true;
                if (!window.pako) {
                    console.error("[Teams NetworkInterceptor] pako dependency not loaded");
                }
                (${teamsBrowserInterceptionLogic.toString()})();
            } catch (e) {
                console.error("[Teams NetworkInterceptor] Initialization error:", e);
            }
        })();
    `

  try {
    await page.addInitScript(script)
    console.log("[Teams NetworkInterceptor] ✅ Browser logic injected")
    return true
  } catch (error) {
    console.error("[Teams NetworkInterceptor] ❌ Failed to inject browser logic:", error)
    return false
  }
}

// Pause gate for the Node-side bridge. The browser interceptor cannot be
// stopped and restarted (its stop flag is terminal), so pause/resume drops
// payloads here instead of tearing the interceptor down.
let interceptionPaused = false

/** Drop network speaker payloads while the recording is paused. */
export function pauseTeamsNetworkInterception(): void {
  interceptionPaused = true
  console.log("[Teams NetworkInterceptor] ⏸️ Speaker updates paused")
}

/** Resume forwarding network speaker payloads after a pause. */
export function resumeTeamsNetworkInterception(): void {
  interceptionPaused = false
  console.log("[Teams NetworkInterceptor] ▶️ Speaker updates resumed")
}

/**
 * Expose the Node-side callback (can run AFTER page.goto()). Reuses Meet's
 * onNetworkSpeakerUpdate name — a bot is only ever one platform, no collision.
 */
export async function setupTeamsNetworkInterceptionCallback(
  page: Page,
  onSpeakersChange: (payload: NetworkPayload) => void
): Promise<boolean> {
  try {
    await page.exposeFunction("onNetworkSpeakerUpdate", (payload: NetworkPayload) => {
      if (interceptionPaused) return
      onSpeakersChange(payload)
    })
    console.log("[Teams NetworkInterceptor] ✅ Callback exposed")
    // Replay the interceptor's retained state to the freshly-bound callback.
    // Emissions before this point were silently dropped (no listener); a
    // dominant-speaker transition that fired in that window would otherwise
    // only surface on the NEXT transition — which a single-speaker meeting may
    // never produce.
    try {
      await page.evaluate(() => window.__teamsNetworkBroadcastNow?.())
      console.log("[Teams NetworkInterceptor] 🔁 Replayed current speaker state to new callback")
    } catch (replayError) {
      console.warn("[Teams NetworkInterceptor] Replay broadcast failed (non-fatal):", replayError)
    }
    return verifyTeamsNetworkInterception(page)
  } catch (error) {
    console.error("[Teams NetworkInterceptor] Failed to expose function:", error)
    return false
  }
}

/** Verify the interceptor and its dependency loaded in the page. */
export async function verifyTeamsNetworkInterception(page: Page): Promise<boolean> {
  try {
    const status = await page.evaluate(() => ({
      hasInterceptor: window.__teamsNetworkInterceptorInitialized === true,
      hasStopFunction: typeof window.__teamsStopNetworkInterception === "function",
      hasPako: typeof (window as unknown as { pako?: unknown }).pako !== "undefined",
      hasCallback: typeof window.onNetworkSpeakerUpdate !== "undefined"
    }))

    console.log("[Teams NetworkInterceptor] Status:", status)

    if (!status.hasInterceptor || !status.hasStopFunction) {
      console.error("[Teams NetworkInterceptor] ❌ Browser interceptor not installed")
      return false
    }
    if (!status.hasPako) {
      console.error("[Teams NetworkInterceptor] ❌ pako dependency missing")
      return false
    }
    if (!status.hasCallback) {
      console.warn("[Teams NetworkInterceptor] ⚠️ Callback not registered yet")
    }
    return true
  } catch (error) {
    console.error("[Teams NetworkInterceptor] ❌ Verification failed:", error)
    return false
  }
}

/** Stop interception (clears the CSRC poll loop and silences callbacks). */
export async function stopTeamsNetworkInterception(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      if (typeof window.__teamsStopNetworkInterception === "function") {
        window.__teamsStopNetworkInterception()
      } else {
        console.warn("[Teams NetworkInterceptor] ⚠️ Stop function not available")
      }
    })
    console.log("[Teams NetworkInterceptor] ✅ Network interception stopped")
  } catch (error) {
    console.error("[Teams NetworkInterceptor] ❌ Failed to stop network interception:", error)
  }
}
