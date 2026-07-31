// Network-based speaker observation for Zoom.
// Node.js setup + browser/Node bridge.

import type { Page } from "@playwright/test"
import { zoomBrowserInterceptionLogic } from "./browser-bundle"

export type { NetworkPayload, NetworkUser } from "./types"
import type { NetworkPayload, ZoomNetDiag } from "./types"

declare global {
  interface Window {
    __zoomNetworkInterceptorMain?: boolean
    __zoomNetworkInterceptorInitialized?: boolean
    __zoomStopNetworkInterception?: () => void
    __zoomNetDiag?: ZoomNetDiag
    __zoomSpeakerQueue?: NetworkPayload[]
  }
}

/** Inject the interceptor. Must run before page.goto(). No libs bundle needed —
 * Zoom's signaling is plain JSON. */
export async function setupZoomNetworkInterceptionScripts(page: Page): Promise<boolean> {
  const script = `
        (function() {
            try {
                window.__zoomNetworkInterceptorMain = true;
                (${zoomBrowserInterceptionLogic.toString()})();
            } catch (e) {
                console.error("[Zoom NetworkInterceptor] Initialization error:", e);
            }
        })();
    `

  try {
    await page.addInitScript(script)
    console.log("[Zoom NetworkInterceptor] ✅ Browser logic injected")
    return true
  } catch (error) {
    console.error("[Zoom NetworkInterceptor] ❌ Failed to inject browser logic:", error)
    return false
  }
}

/** Expose the Node callback (can run after goto). Reuses Meet's
 * onNetworkSpeakerUpdate name — a bot is only ever one platform. */
export async function setupZoomNetworkInterceptionCallback(
  page: Page,
  onSpeakersChange: (payload: NetworkPayload) => void
): Promise<boolean> {
  try {
    await page.exposeFunction("onNetworkSpeakerUpdate", onSpeakersChange)
    console.log("[Zoom NetworkInterceptor] ✅ Callback exposed")

    // Drained queue, same as Teams: exposeFunction bindings aren't reliably visible
    // inside the interceptor's context, but page.evaluate can always read globals.
    let drainedTotal = 0
    const drainSpeakerQueue = async () => {
      try {
        const payloads = await page.evaluate(() => {
          const q = window.__zoomSpeakerQueue || []
          window.__zoomSpeakerQueue = []
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

    // Browser console is filtered in prod, so surface the counters here instead.
    // A stalled stage is obvious: json=0 opaque frames, roster=0 nothing matched,
    // spk=0 no active-speaker signal.
    // Each opcode's key paths are printed once, the first poll after they appear.
    const loggedShapes = new Set<string>()
    const diagPoll = setInterval(() => {
      void (async () => {
        try {
          const d = await page.evaluate(() => window.__zoomNetDiag ?? null)
          if (d) {
            // Paths only, no values. Limited to opcodes carrying a roster or speaker;
            // these are what identify the replacements if Zoom renumbers events.
            for (const [evt, paths] of Object.entries(d.evtShapes ?? {})) {
              if (loggedShapes.has(evt)) continue
              const carriesRoster = paths.some((path) => /\.(dn2?|displayName)\b/.test(path))
              const carriesSpeaker = paths.some((path) => /\b(asn\d+|activeNodeID|nLevel)\b/.test(path))
              if (!carriesRoster && !carriesSpeaker) continue
              loggedShapes.add(evt)
              console.log(`[Zoom NetworkInterceptor] shape evt=${evt} ${paths.join(" ")}`)
            }
            const topEvts = Object.entries(d.evtCounts ?? {})
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([evt, count]) => `${evt}x${count}`)
              .join(",")
            console.log(
              `[Zoom NetworkInterceptor] diag ws=${d.wsCreated} frames=${d.wsFrames}` +
                ` json=${d.jsonFrames} worker=${d.workerMsgs} roster=${d.rosterFrames}` +
                ` participants=${d.rosterParticipants} spk=${d.speakerFrames}` +
                ` rtc=${d.rtcCreated} recv=${d.receiversAdded} csrc=${d.csrcAvailable}` +
                ` bcast=${d.broadcasts} qLen=${d.queueLen} drained=${drainedTotal}` +
                ` lvl=${d.levelMin}..${d.levelMax} lvlAuth=${d.levelsAuthoritative}` +
                ` asEvt=${d.activeSpeakerEvt}` +
                ` evt=[${topEvts}] spkKeys=[${(d.speakerKeys ?? []).join(",")}]`
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

    return verifyZoomNetworkInterception(page)
  } catch (error) {
    console.error("[Zoom NetworkInterceptor] Failed to expose function:", error)
    return false
  }
}

/** Verify the interceptor installed in the page. */
export async function verifyZoomNetworkInterception(page: Page): Promise<boolean> {
  try {
    const status = await page.evaluate(() => ({
      hasInterceptor: window.__zoomNetworkInterceptorInitialized === true,
      hasStopFunction: typeof window.__zoomStopNetworkInterception === "function",
      hasCallback: typeof window.onNetworkSpeakerUpdate !== "undefined"
    }))

    console.log("[Zoom NetworkInterceptor] Status:", status)

    if (!status.hasInterceptor || !status.hasStopFunction) {
      console.error("[Zoom NetworkInterceptor] ❌ Browser interceptor not installed")
      return false
    }
    if (!status.hasCallback) {
      console.warn("[Zoom NetworkInterceptor] ⚠️ Callback not registered yet")
    }
    return true
  } catch (error) {
    console.error("[Zoom NetworkInterceptor] ❌ Verification failed:", error)
    return false
  }
}

/** Stop interception (clears the CSRC poll loop and silences callbacks). */
export async function stopZoomNetworkInterception(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      if (typeof window.__zoomStopNetworkInterception === "function") {
        window.__zoomStopNetworkInterception()
      } else {
        console.warn("[Zoom NetworkInterceptor] ⚠️ Stop function not available")
      }
    })
    console.log("[Zoom NetworkInterceptor] ✅ Network interception stopped")
  } catch (error) {
    console.error("[Zoom NetworkInterceptor] ❌ Failed to stop network interception:", error)
  }
}
