import { execFile } from "child_process"
import type { BrowserContext } from "@playwright/test"
import { fetchBurnedAsns } from "../api/methods"
import { getExitAsn, startToggleProxy, stopToggleProxy } from "../proxy/toggle-proxy"
import { GLOBAL } from "../singleton"
import { MAX_RETRY_COUNT } from "../config/retry-config"
import { formatError } from "../utils/Logger"
import { openBrowser } from "./browser"

const LAUNCH_ATTEMPTS = 3
const LAUNCH_TIMEOUT_MS = 60_000
// Give the graceful context.close() only a tiny window before force-reaping the
// tree. This isn't about flushing data (the profile is a throwaway temp dir) — a
// brief close lets Playwright's local juggler transport detach cleanly, so a cold
// SIGKILL doesn't leave in-flight page ops rejecting with "Target closed" (which
// would trip the crash handler). It's a local transport, not a network round-trip,
// so ~750ms is plenty; pkill -9 below is instant, keeping the fast retry fast.
const BROWSER_CLOSE_TIMEOUT_MS = 750

/**
 * Force-reap any Firefox/stealthfox processes still alive after context.close().
 * One stealthfox is ~15 processes (main + content/utility/RDD/socket children,
 * ~2.4GB total); a hung or botched close leaves that tree running, and each
 * in-process retry then stacks another ~2.4GB → OOMKill at the 8Gi limit. Each
 * pod runs exactly ONE bot and teardown only runs on the in-process-retry recycle
 * (never during a live good recording), so SIGKILL-ing every firefox process is
 * safe. Best-effort — a missing pkill / no matching process must not throw.
 */
async function killBrowserProcesses(): Promise<void> {
  await new Promise<void>((resolve) => {
    // -9: content processes ignore SIGTERM; -f: match the binary path in argv.
    execFile("pkill", ["-9", "-f", "firefox"], () => resolve())
  })
}

// Minimal slice of MeetingContext this module owns: the residential proxy URL
// and the live browser context. Kept structural so both the state machine
// context and the in-process retry can pass their context in directly.
type BrowserSession = { proxyUrl?: string; browserContext?: BrowserContext }

/**
 * Start the residential proxy (Meet/Zoom) and launch the browser against it,
 * writing proxyUrl + browserContext into `session`. The proxy session id is
 * derived from the SQS retry count (a new pod → a new exit IP) plus an optional
 * `sessionSuffix` that advances the exit IP for an in-process retry in the same
 * pod. Launch is retried a few times. Reused by InitializationState and the
 * in-process fast-retry so both share one launch/proxy path.
 */
export async function establishBrowserSession(
  session: BrowserSession,
  opts: { sessionSuffix?: string } = {}
): Promise<void> {
  const platform = GLOBAL.get().meeting_platform
  const retryCount = GLOBAL.getRetryCount()

  if (!session.proxyUrl && (platform === "meet" || platform === "zoom")) {
    // Meet's "last retry runs without proxy" fallback does NOT apply to Zoom:
    // the browser-join wall blocks datacenter/pod IPs outright, so every Zoom
    // attempt must egress through the proxy — its retry value comes from cycling
    // to a fresh exit IP, not from dropping the proxy.
    if (platform === "meet" && retryCount >= MAX_RETRY_COUNT) {
      console.log("[BrowserSession] Last retry attempt — running without proxy")
    } else {
      const proxyUrl = await startToggleProxy(
        GLOBAL.get().bot_uuid,
        retryCount,
        opts.sessionSuffix
      )
      if (proxyUrl) session.proxyUrl = proxyUrl

      // Burned-ASN avoidance (Meet only). startToggleProxy already probed the
      // exit IP + ASN. If we landed on a network Google is currently flagging,
      // rotate the Decodo session to a fresh IP BEFORE spending a browser launch
      // + join on it — cheap because we're still pre-launch. Bounded; fail-soft
      // (an empty burned list or exhausted rotations just proceeds).
      if (session.proxyUrl && platform === "meet") {
        const burned = await fetchBurnedAsns()
        if (burned.length > 0) {
          const MAX_ASN_ROTATIONS = 3
          for (let rot = 1; rot <= MAX_ASN_ROTATIONS; rot++) {
            const asn = getExitAsn()
            if (asn === null || !burned.includes(asn)) break
            console.warn(
              `[BrowserSession] exit ASN ${asn} is burned on Meet — rotating Decodo session (${rot}/${MAX_ASN_ROTATIONS})`
            )
            const rotated = await startToggleProxy(
              GLOBAL.get().bot_uuid,
              retryCount,
              `${opts.sessionSuffix ?? ""}r${rot}`
            )
            if (!rotated) break
            session.proxyUrl = rotated
          }
        }
      }
    }
  }

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    try {
      console.info(`Browser setup attempt ${attempt}/${LAUNCH_ATTEMPTS}`)
      // Hoist the timer id so it's cleared once the race settles (either side).
      // Leaving it pending keeps the event loop alive, delays shutdown, and — in
      // the in-process retry loop — accumulates one dangling 60s timer per attempt.
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Browser setup timeout (${LAUNCH_TIMEOUT_MS}ms)`))
        }, LAUNCH_TIMEOUT_MS)
      })
      try {
        const result = await Promise.race([openBrowser(session.proxyUrl), timeoutPromise])
        session.browserContext = result.browser
        console.info("Browser setup completed successfully")
        return
      } finally {
        clearTimeout(timeoutId)
      }
    } catch (error) {
      lastError = error as Error
      console.error(`Browser setup attempt ${attempt} failed:`, formatError(error))
      if (attempt < LAUNCH_ATTEMPTS) {
        const waitTime = attempt * 5000 // 5s, 10s progressive backoff
        console.info(`Waiting ${waitTime}ms before retry...`)
        await new Promise((resolve) => setTimeout(resolve, waitTime))
      }
    }
  }
  throw lastError || new Error("Browser setup failed after multiple attempts")
}

/**
 * Tear down the browser context + residential proxy so the next
 * establishBrowserSession() launches cleanly on a fresh exit IP. Xvfb,
 * PulseAudio and the screen recorder stay up — only the browser + proxy chain
 * are recycled. Best-effort: errors are logged, never thrown.
 */
export async function teardownBrowserSession(session: BrowserSession): Promise<void> {
  try {
    // Closing a persistent context closes its pages AND the browser — but on a
    // hung/stuck page (e.g. the anti-bot wall) close() can hang or reject. Bound
    // it so a stuck close can't block the in-process retry indefinitely.
    await Promise.race([
      session.browserContext?.close() ?? Promise.resolve(),
      new Promise<void>((resolve) => setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS))
    ])
  } catch (error) {
    console.warn("[BrowserSession] Error closing browser context:", formatError(error))
  }
  session.browserContext = undefined
  // Reap any Firefox tree that survived (or outran) the close, so the next
  // establishBrowserSession() never stacks a second ~2.4GB browser → OOMKill.
  await killBrowserProcesses()
  await stopToggleProxy()
  session.proxyUrl = undefined
}
