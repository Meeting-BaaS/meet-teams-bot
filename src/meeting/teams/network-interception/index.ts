// Network-based speaker observation for Microsoft Teams.
// Node.js setup + browser/Node bridge.

import path from "node:path"
import type { Page } from "@playwright/test"
import { teamsBrowserInterceptionLogic } from "./browser-bundle"
import { resolveSpeakingSet } from "./speaker-timeline"

export type { NetworkPayload, NetworkUser } from "./types"
import type { NetworkPayload } from "./types"

declare global {
  interface Window {
    __teamsNetworkInterceptorMain?: boolean
    __teamsNetworkInterceptorInitialized?: boolean
    __teamsStopNetworkInterception?: () => void
    __teamsNetDiag?: Record<string, number | boolean>
    __teamsSpeakerQueue?: NetworkPayload[]
  }
}

/**
 * Inject interception scripts; must run BEFORE page.goto() (addInitScript only
 * applies to later navigations). Reuses the shared Meet libs bundle for pako.
 */
export async function setupTeamsNetworkInterceptionScripts(page: Page): Promise<boolean> {
  try {
    const bundlePath = path.resolve(
      __dirname,
      "../../meet/network-interception/bundle/network-interceptor-libs.bundle.js"
    )
    await page.addInitScript({ path: bundlePath })
    console.log("[Teams NetworkInterceptor] ✅ Libraries bundle loaded from file")
  } catch (error) {
    console.error("[Teams NetworkInterceptor] ❌ Failed to load libraries bundle:", error)
    return false
  }

  const script = `
        (function() {
            try {
                window.__teamsNetworkInterceptorMain = true;
                if (!window.pako) {
                    console.error("[Teams NetworkInterceptor] pako dependency not loaded");
                }
                // As source: the stringified bundle cannot import it.
                (${teamsBrowserInterceptionLogic.toString()})(${resolveSpeakingSet.toString()});
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

/**
 * Expose the Node-side callback (can run AFTER page.goto()). Reuses Meet's
 * onNetworkSpeakerUpdate name — a bot is only ever one platform, no collision.
 */
export async function setupTeamsNetworkInterceptionCallback(
  page: Page,
  onSpeakersChange: (payload: NetworkPayload) => void
): Promise<boolean> {
  try {
    await page.exposeFunction("onNetworkSpeakerUpdate", onSpeakersChange)
    console.log("[Teams NetworkInterceptor] ✅ Callback exposed")

    // Speaker delivery via a drained queue: exposeFunction's window binding is not
    // visible inside the interceptor bundle's context under CloakBrowser, but
    // page.evaluate can read globals the bundle writes — so the bundle pushes speaker
    // payloads onto window.__teamsSpeakerQueue and we drain + dispatch them here.
    let drainedTotal = 0
    const drainSpeakerQueue = async () => {
      try {
        const payloads = await page.evaluate(() => {
          const q = window.__teamsSpeakerQueue || []
          window.__teamsSpeakerQueue = []
          return q
        })
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
