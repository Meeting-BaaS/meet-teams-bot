import { execFile } from "child_process"
import type { BrowserContext } from "@playwright/test"
import { fetchBurnedAsns, isBurnedExit } from "../api/methods"
import {
  getExitAsn,
  getExitGeo,
  resolveProxyCountries,
  startToggleProxy,
  stopToggleProxy
} from "../proxy/toggle-proxy"
import { GLOBAL } from "../singleton"
import { MeetingEndReason } from "../state-machine/types"
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
    // On the last retry, Meet used to run WITHOUT a proxy — but a datacenter/pod
    // IP is the single strongest bot signal and gets flagged on sight (verified
    // in prod: the no-proxy attempt is the one that flags). So even the last
    // attempt egresses through the proxy; it just drops the geo pin for a random
    // residential exit (skipGeoPin) — a fresh network to shake things up, minus
    // the datacenter IP. (Zoom never went proxy-less either — its browser-join
    // wall blocks datacenter IPs outright.)
    if (platform === "meet" && retryCount >= MAX_RETRY_COUNT) {
      console.log("[BrowserSession] Last retry — random residential exit (skipGeoPin)")
      const proxyUrl = await startToggleProxy(
        GLOBAL.get().bot_uuid,
        retryCount,
        opts.sessionSuffix,
        { skipGeoPin: true }
      )
      if (proxyUrl) session.proxyUrl = proxyUrl
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
        if (burned.asns.length > 0 || burned.pairs.size > 0) {
          // Burned is keyed on (ASN, country) when the exit's country is
          // known — a carrier can be burned in SG and clean in BR, so the
          // pair check avoids over-rotating off usable routes. Falls back
          // to the global ASN list when the geo probe didn't resolve.
          const exitIsBurned = () => isBurnedExit(burned, getExitAsn(), getExitGeo()?.country ?? null)
          const ROTATIONS_PER_REGION = 3
          // The team's selected regions, in order. resolveProxyCountries()
          // never returns [] -- an unselected team still gets the env default
          // or a rotated DEFAULT_PROXY_COUNTRIES candidate set.
          // Try each region in turn; within a region, rotate the Decodo session
          // up to N times hunting a non-burned ASN. When a region's pool keeps
          // handing back burned networks, fall through to the NEXT selected
          // region before giving up — the same fallthrough contract a regional
          // outage already gets, so ASN exhaustion no longer strands us on one
          // region's burned pool.
          const regions = resolveProxyCountries()
          const passes = Math.max(regions.length, 1)
          let cleared = false
          for (let r = 0; r < passes && !cleared; r++) {
            // Excluding regions[0..r-1] pins startToggleProxy to region r; the
            // same exclusion is reused for that region's rotations so they stay
            // in-region and only advance the exit IP.
            const triedCountries = regions.slice(0, r)
            let lastAsn: number | null = null
            for (let rot = 1; rot <= ROTATIONS_PER_REGION; rot++) {
              const asn = getExitAsn()
              if (!exitIsBurned()) {
                cleared = true
                break
              }
              // A rotation that hands back the SAME burned ASN means this region's
              // pool won't diversify — a country served by one dominant ISP (e.g.
              // FR ≈ Orange AS5511). Don't waste the remaining rotations here;
              // advance to the next selected region instead.
              if (asn === lastAsn) {
                console.warn(
                  `[BrowserSession] ${regions[r] ? `region ${regions[r]}` : "current region"} keeps returning burned ASN ${asn} — skipping to next region`
                )
                break
              }
              lastAsn = asn
              const where = regions[r] ? `region ${regions[r]}` : "current region"
              console.warn(
                `[BrowserSession] exit ASN ${asn} is burned on Meet — rotating Decodo session → ${where} (${rot}/${ROTATIONS_PER_REGION})`
              )
              const rotated = await startToggleProxy(
                GLOBAL.get().bot_uuid,
                retryCount,
                `${opts.sessionSuffix ?? ""}r${r}s${rot}`,
                { triedCountries }
              )
              if (!rotated) {
                // The rotation tore down the previous proxy (startToggleProxy is
                // now re-entrant) and did not bring a new one up — don't launch
                // against a dead proxy URL; fall through to a direct Meet join
                // (the same degradation as the last-retry no-proxy path).
                session.proxyUrl = undefined
                cleared = true
                break
              }
              session.proxyUrl = rotated
            }
            // Region exhausted and still burned → outer loop advances to the
            // next selected region.
          }

          // Every selected region was ASN-burned. Rather than launch on a
          // known-burned pinned exit, drop the geo pin entirely for a random
          // residential exit (a different ASN pool) — the same final degradation
          // the regional-outage path takes (skipGeoPin). Only when we still hold
          // a live proxy (a null rotation above already fell back to direct).
          // The unpinned exit is VERIFIED too: a random rotation can land right
          // back on a burned network (observed in prod: AS5511 serving at ~78%
          // flagged despite being burned), so retry a bounded number of times
          // rather than launching on the first unchecked exit.
          if (!cleared && session.proxyUrl && exitIsBurned()) {
            const NO_PIN_ROTATIONS = 3
            for (let rot = 1; rot <= NO_PIN_ROTATIONS; rot++) {
              console.warn(
                `[BrowserSession] all selected regions ASN-burned on Meet — rotating without geo pin (${rot}/${NO_PIN_ROTATIONS})`
              )
              const rotated = await startToggleProxy(
                GLOBAL.get().bot_uuid,
                retryCount,
                `${opts.sessionSuffix ?? ""}rNoPin${rot}`,
                { skipGeoPin: true }
              )
              if (!rotated) {
                // Rotation tore the proxy down without a replacement — same
                // direct-join degradation as the in-region path above.
                session.proxyUrl = undefined
                break
              }
              session.proxyUrl = rotated
              if (!exitIsBurned()) break
              if (rot === NO_PIN_ROTATIONS) {
                console.warn(
                  `[BrowserSession] unpinned exit still burned after ${NO_PIN_ROTATIONS} rotations — launching anyway (fail-soft)`
                )
              }
            }
          }
        }
      }
    }
  }

  // Meet, no proxy, retries remain → requeue instead of joining direct.
  // A proxyless Meet join comes from the pod's datacenter IP and flags ~94%
  // (measured in prod during the 2026-08-10 Decodo capacity burst: 523
  // upstream_unreachable joins → 491 flagged) — it burns the team's
  // reputation and the join usually fails anyway. The SQS requeue lands on a
  // fresh pod later, when the pool has headroom. Checked HERE, immediately
  // before launch, so it also covers the burned-ASN rotation paths above that
  // clear session.proxyUrl on a failed rotation — not just the initial proxy
  // start. The LAST retry still falls back to a live/direct exit as the
  // final resort rather than never joining.
  if (platform === "meet" && !session.proxyUrl && retryCount < MAX_RETRY_COUNT) {
    console.warn(
      "[BrowserSession] Meet proxy unavailable — requeueing instead of a direct (datacenter-IP) join"
    )
    GLOBAL.setError(MeetingEndReason.ProxyUnavailable)
    GLOBAL.setShouldRetry(true)
    throw new Error(
      "Residential proxy unavailable for Meet join — requeueing to retry when the pool has capacity"
    )
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
