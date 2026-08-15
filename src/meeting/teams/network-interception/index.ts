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
    __teamsNetDiag?: Record<string, number | boolean>
    __teamsSpeakerQueue?: NetworkPayload[]
    __teamsDiagQueue?: string[]
    onNetworkInterceptorDiag?: (message: string) => void
    onNetworkSpeakerUpdate?: (payload: NetworkPayload) => void
    pako?: unknown
  }
}

/**
 * Inject interception scripts; must run BEFORE page.goto() (addInitScript only
 * applies to later navigations).
 */
// Pages whose console we already forward — avoid duplicate listeners.
const consoleForwardedPages = new WeakSet<Page>()

/**
 * Forward the bundle's in-page console lines into the bot log. Without this,
 * the interceptor's own diagnostics (hooks attached, receivers added,
 * speaking=[...] transitions, watchdog verdicts) are invisible post-mortem.
 */
function forwardInterceptorConsole(page: Page): void {
  if (consoleForwardedPages.has(page)) return
  consoleForwardedPages.add(page)
  page.on("console", (msg) => {
    try {
      const text = msg.text()
      if (text.includes("[NetworkInterceptor][Teams]")) {
        console.log(`[TeamsPage] ${text}`)
      }
    } catch {
      // console message already disposed — ignore
    }
  })
}

export async function setupTeamsNetworkInterceptionScripts(page: Page): Promise<boolean> {
  try {
    forwardInterceptorConsole(page)
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
    // Diagnostics bridge — the bundle routes its own root-cause lines through
    // here (CloakBrowser's stealth page does not surface page.on('console')).
    try {
      await page.exposeFunction("onNetworkInterceptorDiag", (message: string) => {
        console.log(`[TeamsInterceptorDiag] ${message}`)
      })
    } catch (e) {
      // already exposed on this page (re-entry) — ignore
    }
    forwardInterceptorConsole(page)
    console.log("[Teams NetworkInterceptor] ✅ Callback exposed")

    // Speaker delivery via a drained queue: exposeFunction's window binding is not
    // visible inside the interceptor bundle's context under CloakBrowser, but
    // page.evaluate can read globals the bundle writes — so the bundle pushes speaker
    // payloads onto window.__teamsSpeakerQueue and we drain + dispatch them here.
    // While paused, drained payloads are discarded (same semantics as the
    // exposeFunction gate above).
    let drainedTotal = 0
    const drainSpeakerQueue = async () => {
      try {
        const { payloads, diags } = (await page.evaluate(() => {
          const w = window as any
          const q = w.__teamsSpeakerQueue || []
          w.__teamsSpeakerQueue = []
          const dq = w.__teamsDiagQueue || []
          w.__teamsDiagQueue = []
          return { payloads: q, diags: dq }
        })) as { payloads: NetworkPayload[]; diags: string[] }
        for (const line of diags) console.log(`[TeamsInterceptorDiag] ${line}`)
        if (interceptionPaused) return
        for (const payload of payloads) {
          drainedTotal++
          onSpeakersChange(payload)
        }
      } catch {
        // page navigating/closed — ignore
      }
    }
    const speakerPoll = setInterval(() => {
      void drainSpeakerQueue()
    }, 250)

    // Pipeline health: browser console is filtered in prod, so read the browser-side
    // counters here and log one concise, non-PII line — a stalled stage is obvious
    // (e.g. rtc=0/dc=0 = RTCPeerConnection never proxied; bcast=0 = nothing detected).
    const diagPoll = setInterval(() => {
      void (async () => {
        try {
          const d = await page.evaluate(() => window.__teamsNetDiag || null)
          if (d) {
            console.log(
              `[Teams NetworkInterceptor] diag ws=${d.wsCreated} rosterFrames=${d.wsRosterFrames}` +
                ` httpRoster=${d.httpRosterHits} roster=${d.rosterParticipants} rtc=${d.rtcCreated}` +
                ` dc=${d.dataChannels} dsh=${d.dshSeen} recv=${d.receiversAdded}` +
                ` csrc=${d.csrcAvailable} bcast=${d.broadcasts} qLen=${d.queueLen} drained=${drainedTotal}` +
                // Caption rung: whether it engaged at all, and whether its speaker
                // ids resolved against the roster. capOn=false on a healthy call is
                // expected — captions only start when the network signal is absent.
                ` capOn=${d.captionsEnabled} capResults=${d.captionResults}` +
                ` capMatched=${d.captionMatched} capUnmatched=${d.captionUnmatched}`
            )
          }
        } catch {
          // page navigating/closed — ignore
        }
      })()
    }, 15000)

    page.on("close", () => {
      clearInterval(speakerPoll)
      clearInterval(diagPoll)
    })

    // Mark callback-bind time in the page (watchdog baseline) and replay the
    // interceptor's retained state so a pre-bind dominant-speaker transition
    // isn't lost until the next transition.
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
