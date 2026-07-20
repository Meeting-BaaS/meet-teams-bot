import type { BrowserContext } from "@playwright/test"
import { startToggleProxy, stopToggleProxy } from "../proxy/toggle-proxy"
import { GLOBAL } from "../singleton"
import { MAX_RETRY_COUNT } from "../config/retry-config"
import { formatError } from "../utils/Logger"
import { openBrowser } from "./browser"

const LAUNCH_ATTEMPTS = 3
const LAUNCH_TIMEOUT_MS = 60_000

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
    }
  }

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    try {
      console.info(`Browser setup attempt ${attempt}/${LAUNCH_ATTEMPTS}`)
      const timeoutPromise = new Promise<never>((_, reject) => {
        const id = setTimeout(() => {
          clearTimeout(id)
          reject(new Error(`Browser setup timeout (${LAUNCH_TIMEOUT_MS}ms)`))
        }, LAUNCH_TIMEOUT_MS)
      })
      const result = await Promise.race([openBrowser(session.proxyUrl), timeoutPromise])
      session.browserContext = result.browser
      console.info("Browser setup completed successfully")
      return
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
    // Closing the context closes all its pages.
    await session.browserContext?.close()
  } catch (error) {
    console.warn("[BrowserSession] Error closing browser context:", formatError(error))
  }
  session.browserContext = undefined
  await stopToggleProxy()
  session.proxyUrl = undefined
}
