import type { BrowserContext, Page } from "@playwright/test"
import { HtmlSnapshotService } from "../services/html-snapshot-service"
import { GLOBAL } from "../singleton"
import { MeetingEndReason } from "../state-machine/types"
import type { MeetingProviderInterface } from "../types"
import { parseMeetingUrlFromJoinInfos } from "../urlParser/teamsUrlParser"
import { formatError } from "../utils/Logger"
import { createStateDetector, patternLocator } from "../utils/meeting-state-detector"
import { sleep } from "../utils/sleep"
import { enableTeamsAudioCapture, verifyTeamsAudioCapture } from "./teams/audio-capture"
import { TEAMS_STATE_CONFIG } from "./teams-state-config"

// Types for Teams chat API interception
interface TeamsChatMessage {
  clientMessageId?: string
  from?: string
  content?: string
  imDisplayName?: string
  renamedDisplayName?: string
  originalArrivalTime?: string
}

interface TeamsBatchEventData {
  data?: {
    chatServiceBatchEvent?: Array<{ message?: TeamsChatMessage }>
  }
}

interface TeamsChatWindow extends Window {
  __teamsChatApiPatched?: boolean
  onTeamsChatMessage?: (msg: {
    text: string
    senderName: string
    timestamp: string
    messageId: string
  }) => void
}

// Create a singleton detector instance for Microsoft Teams
const teamsStateDetector = createStateDetector(TEAMS_STATE_CONFIG)

/**
 * Fetch the meeting URL out-of-band to learn its HTTP status. Used to classify
 * a goto() that threw ERR_HTTP_RESPONSE_CODE_FAILURE (Firefox throws instead of
 * resolving the response, so the in-page status check never runs). Returns the
 * final status after redirects, or null when the probe itself failed — callers
 * must treat null as "unknown", not as an error status.
 */
async function probeUrlStatus(url: string): Promise<number | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal
      })
      return response.status
    } finally {
      clearTimeout(timeout)
    }
  } catch (probeError) {
    console.warn(
      "[Teams] URL status probe failed:",
      probeError instanceof Error ? probeError.message : probeError
    )
    return null
  }
}

export class TeamsProvider implements MeetingProviderInterface {
  async parseMeetingUrl(meeting_url: string) {
    return parseMeetingUrlFromJoinInfos(meeting_url)
  }
  getMeetingLink(meeting_id: string, _password: string, _role: number, _bot_name: string) {
    return meeting_id
  }

  async openMeetingPage(
    browserContext: BrowserContext,
    link: string,
    streaming_input: string | undefined,
    attempts = 0
  ): Promise<Page> {
    const url = new URL(link)

    // Authenticated Teams bots: reuse the page the sign-in flow left open on
    // teams.microsoft.com (it holds the live MSAL session). Opening a FRESH page
    // forces a silent re-auth that loses the race to the meeting redirect and lands
    // on the anonymous /light-meetings launcher (anon=true → guest/name prompt).
    // Reusing the already-signed-in tab is how a human joins. Anonymous bots (no
    // teams_login_config) open a fresh page exactly as before.
    // Match every Teams host: the signed-in page is bounced from teams.microsoft.com
    // to teams.cloud.microsoft (the ocdiRedirect migration), so a teams.microsoft.com-
    // only filter misses the authenticated tab entirely and we fall back to a fresh
    // page — which re-auths, loses the race, and joins anonymously.
    const isAuthenticatedTeams = Boolean(GLOBAL.get().teams_login_config)
    const reusablePage = isAuthenticatedTeams
      ? browserContext
          .pages()
          .find((p) =>
            /(teams\.microsoft\.com|cloud\.microsoft|teams\.live\.com)/i.test(p.url())
          )
      : undefined
    const page = reusablePage ?? (await browserContext.newPage())
    if (reusablePage) {
      console.log("[teams] reusing the authenticated sign-in page for the meeting join")
    }

    page.setDefaultTimeout(30000)
    page.setDefaultNavigationTimeout(30000)

    // Always grant permissions for microphone and camera
    // Required to capture sound and video
    await browserContext.grantPermissions(["microphone", "camera"], {
      origin: url.origin
    })

    // ── Block Teams' native-app deep link ────────────────────────────────────
    // The teams.live.com launcher fires a custom-scheme deep link (msteams:…) to
    // open the desktop app. Chromium intercepts the unknown scheme and shows a
    // tab-modal "Open xdg-open?" dialog — native browser UI Playwright cannot
    // click — which freezes the join even though the web pre-join renders behind
    // it. This init script runs before the launcher's JS and neutralizes every
    // in-page vector that keeps the current page alive (window.open, location.*,
    // iframe.src, anchor clicks, setAttribute), so the deep link never fires.
    // Scoped to non-http(s) schemes only, so normal Teams web navigation is
    // untouched. Blocked targets are logged so we can confirm the exact scheme.
    await page.addInitScript(() => {
      const ALLOWED = /^(https?|about|blob|data|filesystem):/i
      const isExternal = (raw: string | null | undefined): boolean => {
        if (!raw) return false
        const s = String(raw).trim()
        if (s === "" || /^[#?/]/.test(s)) return false // relative / hash / query
        if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) return false // no scheme → relative
        return !ALLOWED.test(s)
      }
      const log = (vector: string, url: string): void => {
        try {
          console.warn(`[Teams DeepLinkBlock] blocked ${vector} → ${url}`)
        } catch (_e) {
          /* console may be unavailable */
        }
      }

      // window.open("scheme:…")
      try {
        const nativeOpen = window.open.bind(window)
        window.open = ((url?: string | URL, ...rest: unknown[]) => {
          if (isExternal(typeof url === "string" ? url : url?.href)) {
            log("window.open", String(url))
            return null
          }
          return (nativeOpen as (...a: unknown[]) => Window | null)(url, ...rest)
        }) as typeof window.open
      } catch (_e) {
        /* leave native window.open in place */
      }

      // location.assign / location.replace
      try {
        const nativeAssign = window.location.assign.bind(window.location)
        window.location.assign = (url: string | URL) => {
          if (isExternal(String(url))) {
            log("location.assign", String(url))
            return
          }
          nativeAssign(url as string)
        }
      } catch (_e) {
        /* leave native location.assign in place */
      }
      try {
        const nativeReplace = window.location.replace.bind(window.location)
        window.location.replace = (url: string | URL) => {
          if (isExternal(String(url))) {
            log("location.replace", String(url))
            return
          }
          nativeReplace(url as string)
        }
      } catch (_e) {
        /* leave native location.replace in place */
      }

      // location.href = "scheme:…" (also catches `window.location = …`)
      try {
        const hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, "href")
        if (hrefDesc?.set && hrefDesc.get) {
          const nativeSet = hrefDesc.set
          const nativeGet = hrefDesc.get
          Object.defineProperty(Location.prototype, "href", {
            configurable: true,
            enumerable: hrefDesc.enumerable,
            get(): string {
              return nativeGet.call(this) as string
            },
            set(v: string): void {
              if (isExternal(v)) {
                log("location.href", String(v))
                return
              }
              nativeSet.call(this, v)
            }
          })
        }
      } catch (_e) {
        /* location.href not overridable here — other vectors still covered */
      }

      // iframe.src = "scheme:…" (property assignment fires a synchronous nav)
      try {
        const srcDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src")
        if (srcDesc?.set && srcDesc.get) {
          const nativeSet = srcDesc.set
          const nativeGet = srcDesc.get
          Object.defineProperty(HTMLIFrameElement.prototype, "src", {
            configurable: true,
            enumerable: srcDesc.enumerable,
            get(): string {
              return nativeGet.call(this) as string
            },
            set(v: string): void {
              if (isExternal(v)) {
                log("iframe.src", String(v))
                return
              }
              nativeSet.call(this, v)
            }
          })
        }
      } catch (_e) {
        /* iframe.src not overridable here — MutationObserver/setAttribute cover it */
      }

      // setAttribute("src"/"href", "scheme:…") on iframe/anchor
      try {
        const nativeSetAttr = Element.prototype.setAttribute
        Element.prototype.setAttribute = function (name: string, value: string): void {
          const n = typeof name === "string" ? name.toLowerCase() : ""
          if (
            ((n === "src" && this.tagName === "IFRAME") ||
              (n === "href" && this.tagName === "A")) &&
            isExternal(value)
          ) {
            log(`setAttribute:${n}`, String(value))
            return
          }
          nativeSetAttr.call(this, name, value)
        }
      } catch (_e) {
        /* leave native setAttribute in place */
      }

      // Programmatic + user anchor clicks (capture phase, before the default)
      document.addEventListener(
        "click",
        (e: Event) => {
          const path = (e.composedPath?.() ?? []) as EventTarget[]
          for (const t of path) {
            const el = t as HTMLAnchorElement
            if (el?.tagName === "A" && isExternal(el.getAttribute?.("href"))) {
              log("anchor.click", String(el.getAttribute("href")))
              e.preventDefault()
              e.stopImmediatePropagation()
              return
            }
          }
        },
        true
      )

      // Statically-parsed <iframe src="scheme:…"> / <a href="scheme:…"> from the
      // SERVER HTML never hit the JS src/href setters or setAttribute above — the
      // parser sets them natively. The Teams launcher ships exactly this: a static
      // <iframe id="teamsLauncher" src="msteams:…"> that fires Chromium's tab-modal
      // "Open Microsoft Teams?" dialog and freezes the join. Neutralise such nodes
      // the instant they're inserted (MutationObserver microtask fires before the
      // browser processes the pending subframe navigation), and sweep any already
      // present. Kept scoped to external (non-http) schemes via isExternal().
      const neutralise = (el: Element): void => {
        try {
          if (el.tagName === "IFRAME" && isExternal(el.getAttribute("src"))) {
            log("static-iframe.src", String(el.getAttribute("src")))
            ;(el as HTMLIFrameElement).src = "about:blank"
            el.remove()
          } else if (el.tagName === "A" && isExternal(el.getAttribute("href"))) {
            log("static-anchor.href", String(el.getAttribute("href")))
            el.removeAttribute("href")
          }
        } catch (_e) {
          /* best-effort */
        }
      }
      const sweep = (root: ParentNode | null): void => {
        try {
          root?.querySelectorAll?.("iframe[src], a[href]").forEach(neutralise)
        } catch (_e) {
          /* best-effort */
        }
      }
      const mo = new MutationObserver((records: MutationRecord[]) => {
        for (const rec of records) {
          rec.addedNodes.forEach((node: Node) => {
            if (node instanceof Element) {
              neutralise(node)
              sweep(node)
            }
          })
        }
      })
      try {
        mo.observe(document, { childList: true, subtree: true })
      } catch (_e) {
        /* document not observable yet — retry when the tree exists */
        document.addEventListener("DOMContentLoaded", () => sweep(document))
      }
      sweep(document)
    })

    // Audio track layer for track detection
    // Audio streaming is handled by FFmpeg PulseAudio capture
    try {
      await enableTeamsAudioCapture(page)
      console.log("[Teams] Audio track layer enabled (streaming via FFmpeg)")
    } catch (error) {
      console.error(
        "[Teams] Failed to enable audio capture, continuing without it:",
        formatError(error)
      )
    }

    // Install chat API interception BEFORE Teams JS loads.
    // Monkey-patches Function.prototype.bind to intercept Teams' internal
    // onMessageReceived handler and extract chat messages from chatServiceBatchEvent.
    // window.onTeamsChatMessage is exposed later by TeamsChatObserver; messages
    // received before that point are silently dropped (bot hasn't joined yet).
    await page.addInitScript(() => {
      const w = window as TeamsChatWindow
      if (w.__teamsChatApiPatched) return
      w.__teamsChatApiPatched = true

      const originalBind = Function.prototype.bind

      // Cache MRI ID → display name mappings learned from messages
      const mriNameCache: Record<string, string> = {}

      function stripHtml(html: string): string {
        return html.replace(/<[^>]*>/g, "")
      }

      Function.prototype.bind = function (thisArg: unknown, ...args: unknown[]) {
        if (this.name === "onMessageReceived") {
          console.log("[TeamsChatAPI] Intercepted onMessageReceived.bind() — hook active")
          const bound = originalBind.apply(this, [thisArg, ...args]) as (...a: unknown[]) => unknown
          return function (...callArgs: unknown[]) {
            try {
              const eventData = callArgs[0] as TeamsBatchEventData | undefined
              const batchEvents = eventData?.data?.chatServiceBatchEvent
              if (Array.isArray(batchEvents)) {
                for (const evt of batchEvents) {
                  const message = evt?.message
                  if (!message?.clientMessageId || !message?.from || !message?.content) continue

                  const messageId = message.clientMessageId
                  const text = stripHtml(message.content)
                  if (!text) continue

                  // Filter out Teams system/metadata messages
                  if (
                    text.includes("\n") &&
                    (text.includes("callEnded") || text.includes("api.flightproxy"))
                  ) {
                    continue
                  }

                  // Resolve sender name: try imDisplayName/renamedDisplayName, then cached MRI lookup, then raw ID
                  const fromId = message.from
                  const displayName = message.imDisplayName || message.renamedDisplayName
                  if (displayName && fromId) {
                    mriNameCache[fromId] = displayName
                  }
                  const senderName = displayName || mriNameCache[fromId] || fromId || "Unknown"
                  const timestamp = message.originalArrivalTime
                    ? new Date(message.originalArrivalTime).toISOString()
                    : new Date().toISOString()

                  if (typeof w.onTeamsChatMessage === "function") {
                    w.onTeamsChatMessage({ text, senderName, timestamp, messageId })
                  }
                }
              }
            } catch (e) {
              console.error("[TeamsChatAPI] Error in interception:", e)
            }
            return bound.apply(this, callArgs)
          }
        }
        return originalBind.apply(this, [thisArg, ...args])
      }

      console.log("[TeamsChatAPI] Function.prototype.bind monkey-patch installed")
    })

    // Inject network speaker-detection scripts BEFORE goto (addInitScript only
    // applies to later navigations). Keep failures local to this page attempt:
    // in-call-state verifies the browser hook after navigation and falls back
    // to UI detection if this injection did not install.
    // Cleanup CSS goes in before navigation so the toolbar, toasts and the live
    // caption overlay are hidden the instant they render. The recorder starts in
    // the waiting room but the HTML cleaner only runs once in-call (~41s later),
    // and that whole window was being recorded showing the raw Teams UI.
    try {
      const { setupTeamsCleanupStyles } = await import("./teams/htmlCleaner")
      await setupTeamsCleanupStyles(page)
    } catch (error) {
      console.error("[Teams] ⚠️ Failed to install cleanup stylesheet:", formatError(error))
    }

    try {
      const { setupTeamsNetworkInterceptionScripts } = await import("./teams/network-interception")
      const success = await setupTeamsNetworkInterceptionScripts(page)
      if (!success) {
        console.warn("[Teams] ⚠️ Failed to setup network interception scripts")
      }
    } catch (error) {
      console.error("[Teams] ⚠️ Error setting up network interception scripts:", formatError(error))
    }

    try {
      const response = await page.goto(link, {
        waitUntil: "load",
        timeout: 15000
      })

      // Catch transient Microsoft edge failures (503/502/504): the page resolves
      // with an HTML error body, the join inputs never appear, and we'd otherwise
      // burn ~12 minutes inside typeBotName before giving up as "Unknown error".
      // Triggering bot: b8dde4b5-18a1-4992-b758-207b4f2183d9 (hit a 62-byte
      // "503 Service Unavailable" page on 2026-04-27 ~13:56 UTC).
      if (response && response.status() >= 500) {
        GLOBAL.setError(
          MeetingEndReason.CannotJoinMeeting,
          `Teams returned HTTP ${response.status()} - service unavailable`
        )
        throw new Error(`Teams page returned HTTP ${response.status()}`)
      }

      // Check for page freeze after goto
      let pageFrozen = false
      try {
        await Promise.race([
          page.evaluate(() => document.readyState),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Page freeze timeout after goto")),
              10000 // 10 seconds timeout to detect freeze
            )
          )
        ])
      } catch (_e) {
        pageFrozen = true
        console.warn(`⚠️ Page appears to be frozen after goto (attempt ${attempts + 1}/3)`)
      }

      // Retry if frozen and we haven't exceeded max attempts
      if (pageFrozen && attempts < 3) {
        await page.close()
        console.log(`🔄 Page freeze detected, retrying... (${attempts + 1}/3)`)
        await sleep(1000) // Wait before retry
        return await this.openMeetingPage(browserContext, link, streaming_input, attempts + 1)
      }
      if (pageFrozen && attempts >= 3) {
        console.warn("⚠️ Page freeze persists after 3 retries, continuing anyway...")
        // Continue - page might recover later
      }

      // Quick check for buttons with reduced timeout
      await Promise.race([
        page.getByRole("button", { name: "Join now" }).waitFor({ timeout: 5000 }),
        page
          .getByRole("button", {
            name: "Continue without audio or video"
          })
          .waitFor({ timeout: 5000 })
      ]).catch(() => {
        // Silent catch - no need to log timeout
      })

      const currentUrl = await page.url()
      const isLightInterface = currentUrl.includes("light-meetings") || currentUrl.includes("light")

      // Teams now often renders in light mode; accept it and continue (no retries)
      if (isLightInterface) {
        console.log("🥕 Light interface detected (expected), continuing...")
      }

      return page
    } catch (error) {
      console.error("Error in openMeetingPage:", formatError(error))
      // Firefox/cloakbrowser goto() THROWS net::ERR_HTTP_RESPONSE_CODE_FAILURE
      // on ANY HTTP error status — unlike Chromium, which resolves the response
      // and reaches the >=500 check above. So both a dead link (4xx) and a Teams
      // outage (5xx) land here and used to fail as retryable UNKNOWN_ERROR
      // (bot eb1eaceb, 2026-07-21: customer sent teams.microsoft.com/123 and
      // burned 3 SQS attempts on a URL that can never work). Probe the URL
      // out-of-band to classify:
      //   4xx -> terminal InvalidMeetingUrl, do NOT retry;
      //   5xx -> CannotJoinMeeting, retryable (transient edge failure);
      //   probe failed -> keep the generic retryable path.
      const errMsg = error instanceof Error ? error.message : String(error)
      if (errMsg.includes("ERR_HTTP_RESPONSE_CODE_FAILURE")) {
        const status = await probeUrlStatus(link)
        if (status !== null && status >= 400 && status < 500) {
          console.log(`🔴 Teams URL returned HTTP ${status} — invalid meeting URL, not retrying`)
          GLOBAL.setError(
            MeetingEndReason.InvalidMeetingUrl,
            `Teams returned HTTP ${status} for the meeting URL — the link is invalid or expired`
          )
          throw error
        }
        if (status !== null && status >= 500) {
          GLOBAL.setError(
            MeetingEndReason.CannotJoinMeeting,
            `Teams returned HTTP ${status} - service unavailable`
          )
        }
      }
      // Mark as retryable - bot hasn't joined yet, so retrying is safe
      console.log("🔄 Error occurred before joining - marking as retryable")
      GLOBAL.setShouldRetry(true)
      throw error
    }
  }

  async joinMeeting(
    page: Page,
    cancelCheck: () => boolean,
    onJoinSuccess: () => void
  ): Promise<void> {
    console.log("joining meeting")

    // Capture DOM state before starting Teams join process
    const htmlSnapshot = HtmlSnapshotService.getInstance()
    await htmlSnapshot.captureSnapshot(page, "teams_join_meeting_start")

    // Authenticated bots go through the FULL Teams web pre-join (Continue on this
    // browser → Join now). The "Continue without audio or video" button is a
    // light/anonymous-interface prompt that never appears there, so its extra retry
    // loops below are skipped for authenticated bots (they were pure dead wait).
    const isAuthenticatedTeams = Boolean(GLOBAL.get().teams_login_config)

    try {
      await ensurePageLoaded(page)
    } catch (error) {
      console.error("Page load failed:", formatError(error))
      throw new Error("Page failed to load - retrying")
    }

    try {
      // Authenticated bots: page-based pre-join driven by TEAMS_STATE_CONFIG's
      // multi-selector patterns (launcher "Continue on this browser" → pre-join
      // "Join now"). Wait for the indicator to be visible, then click through
      // Playwright so CloakBrowser's humanized click applies — no blind retry loop.
      // (Anonymous/other interfaces fall through to the generic button loop below.)
      if (isAuthenticatedTeams) {
        const continuePat = TEAMS_STATE_CONFIG.continueOnBrowserPattern
        const preJoinPat = TEAMS_STATE_CONFIG.preJoinPattern

        // This link may open the launcher OR land straight on the pre-join.
        if (continuePat && preJoinPat) {
          await patternLocator(page, continuePat)
            .or(patternLocator(page, preJoinPat))
            .first()
            .waitFor({ state: "visible", timeout: 30_000 })
            .catch(() => {})
        }
        if (await isOnMicrosoftLoginPage(page)) throw new Error("LoginRequired")

        // On the launcher, click through to the web pre-join, then wait for it.
        const onLauncher =
          !!continuePat &&
          (await patternLocator(page, continuePat)
            .first()
            .isVisible()
            .catch(() => false))
        if (onLauncher && continuePat) {
          await patternLocator(page, continuePat)
            .first()
            .click({ timeout: 3_000 })
            .then(() => console.log('✅ [teams] clicked "Continue on this browser"'))
            .catch((e) =>
              console.warn(`[teams] continue-on-browser click failed: ${formatError(e)}`)
            )
          if (preJoinPat) {
            await patternLocator(page, preJoinPat)
              .first()
              .waitFor({ state: "visible", timeout: 30_000 })
              .catch(() => {})
          }
        } else {
          console.log("✅ [teams] already at the pre-join (Join now) screen")
        }
      }

      // Try multiple approaches to handle Teams button scenarios (anonymous/other
      // interfaces). Authenticated bots handled the pre-join page-based above, so skip.
      const maxAttempts = isAuthenticatedTeams ? 0 : 15

      for (let i = 0; i < maxAttempts; i++) {
        if (cancelCheck?.()) break

        // Check if we've been redirected to a login page
        if (await isOnMicrosoftLoginPage(page)) {
          throw new Error("LoginRequired")
        }

        // Check all buttons in one pass with more attempts
        const [continueOnBrowser, joinNow, continueWithoutAudio] = await Promise.all([
          clickWithInnerText(page, "button", "Continue on this browser", 2, false),
          clickWithInnerText(page, "button", "Join now", 2, false),
          clickWithInnerText(page, "button", "Continue without audio or video", 2, false)
        ])

        if (continueOnBrowser) {
          await clickWithInnerText(page, "button", "Continue on this browser", 3, true)
          console.log('✅ Clicked "Continue on this browser"')
          break
        }

        if (joinNow) {
          console.log("✅ Already at Join screen")
          break
        }

        if (continueWithoutAudio) {
          await clickWithInnerText(page, "button", "Continue without audio or video", 3, true)
          console.log('✅ Clicked "Continue without audio"')
          // Don't break immediately - sometimes there are multiple steps
          await sleep(1000)
        }

        if (i === 7) console.log("⏳ Still looking for Teams buttons...") // Log midway
        await sleep(300) // Slightly reduced wait time
      }

      // Extra attempts for "Continue without audio" in light interface (skip for
      // authenticated bots — that button isn't part of the authenticated pre-join).
      if (!isAuthenticatedTeams) {
        console.log('🔄 Extra attempts for "Continue without audio or video"...')
        for (let i = 0; i < 5; i++) {
          if (cancelCheck?.()) break

          // Check if we've been redirected to a login page
          if (await isOnMicrosoftLoginPage(page)) {
            throw new Error("LoginRequired")
          }

          const found = await clickWithInnerText(
            page,
            "button",
            "Continue without audio or video",
            3,
            true
          )
          if (found) {
            console.log('✅ Successfully clicked "Continue without audio" (extra attempt)')
            await sleep(1000)
            break
          }
          await sleep(500)
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message === "LoginRequired") {
        throw e // Re-throw LoginRequired errors
      }
      console.warn("Failed during Teams button handling:", e)
    }

    const currentUrl = await page.url()
    const isLightInterface = currentUrl.includes("light")
    const isLiveInterface = currentUrl.includes("live")

    console.log(
      "interface : ",
      isLightInterface ? "light 🥕🥕" : isLiveInterface ? "live 💃🏼" : "old 👴🏻",
      "url: ",
      currentUrl
    )

    try {
      // Wait for the pre-join "Join now" to render (detection barrier; the real click
      // happens below). 12 attempts with the capped backoff is up to ~6s if it's slow,
      // and returns the instant it appears — the old count of 100 could wait minutes.
      await clickWithInnerText(page, "button", "Join now", 12, false)
    } catch (e) {
      console.warn('Failed to find "Join now" button (first attempt):', e)
    }

    // Additional attempt for "Continue without audio" in case it appears later (skip
    // for authenticated bots — not part of the authenticated pre-join).
    if (!isAuthenticatedTeams) {
      try {
        console.log('🔄 Additional attempt for "Continue without audio or video"...')
        for (let i = 0; i < 3; i++) {
          if (cancelCheck?.()) break

          const found = await clickWithInnerText(
            page,
            "button",
            "Continue without audio or video",
            2,
            true
          )
          if (found) {
            console.log('✅ Successfully clicked "Continue without audio" (delayed attempt)')
            await sleep(1000)
            break
          }
          await sleep(500)
        }
      } catch (e) {
        console.warn('Additional "Continue without audio" attempt failed:', e)
      }
    }

    const streaming_input = GLOBAL.get().streaming_input
    if (streaming_input) {
      await Promise.race([activateMicrophone(page), sleep(2000)])
    } else {
      await Promise.race([deactivateMicrophone(page), sleep(2000)])
    }

    // Turn the bot camera on (branding image) for the light interface AND the
    // authenticated v2 client — previously the camera stayed off on v2 so no picture.
    const enableCamera = isLightInterface || Boolean(GLOBAL.get().teams_login_config)
    if (enableCamera) {
      try {
        if (isLightInterface) await handlePermissionDialog(page)

        // Quick camera/mic setup with timeouts
        await Promise.race([
          activateCamera(page),
          sleep(3000).then(() => {
            throw new Error("Camera timeout")
          })
        ]).catch((e) => console.warn("Camera setup failed:", e instanceof Error ? e.message : e))
      } catch (e) {
        console.warn(
          "Camera/mic setup failed, continuing:",
          e instanceof Error ? e.message : String(e)
        )
      }
    }

    // Final stop check before the irreversible "Join now" click
    if (cancelCheck()) {
      console.log("Stop request detected before clicking Join now — aborting")
      GLOBAL.setError(MeetingEndReason.ExitingMeetingBeforeRecord)
      throw new Error("Bot stopped before joining meeting")
    }

    try {
      // Authenticated bots join AS the signed-in user — the name comes from the
      // Microsoft account, and the authenticated pre-join has no guest-name field.
      // Only type a guest name on the anonymous path; the waiting-room clears
      // teams_login_config when it falls back to anonymous, so its presence here
      // means sign-in succeeded and we must NOT type a name (doing so is the "types
      // the name / joins as guest" bug). Respects the fallback config by construction.
      if (isAuthenticatedTeams) {
        // Join AS the signed-in user (no guest-name field). Click via the multi-selector
        // pre-join pattern; fall back to the exact-text click if it didn't resolve.
        console.log("[teams] authenticated bot — joining as signed-in user (no guest name)")
        const preJoinPat = TEAMS_STATE_CONFIG.preJoinPattern
        const clicked = preJoinPat
          ? await patternLocator(page, preJoinPat)
              .first()
              .click({ timeout: 5_000 })
              .then(() => true)
              .catch(() => false)
          : false
        if (!clicked) await clickWithInnerText(page, "button", "Join now", 20)
      } else {
        await typeBotName(page, GLOBAL.get().bot_name, 20)
        await clickWithInnerText(page, "button", "Join now", 20)
      }
    } catch (e) {
      console.error('Error during bot name typing or second "Join now" click:', e)
      throw new Error("RetryableError")
    }

    // Wait to be in the meeting
    console.log("Waiting to confirm meeting join...")
    let inMeeting = false

    while (!inMeeting) {
      // Check if we have been refused (or sign-in is required). isBotNotAccepted
      // sets the precise end reason (BotNotAccepted, LoginRequired, …) from the
      // matched denial pattern, so we just need to bail out here.
      if (await isBotNotAccepted(page)) {
        throw new Error("Bot not accepted into Teams meeting")
      }

      // Check if we should cancel
      if (cancelCheck()) {
        // Only set error if not already set by stopMeeting()
        if (!GLOBAL.getEndReason()) {
          GLOBAL.setError(MeetingEndReason.ApiRequest)
        }
        throw new Error("API request to stop Teams recording")
      }

      // Check if we are in the meeting (multiple indicators)
      inMeeting = await isInTeamsMeeting(page)

      if (!inMeeting) {
        await sleep(1000)
      }
    }

    console.log("Successfully confirmed we are in the meeting")

    // Guarantee the bot is muted after actually entering the call — the pre-join mute
    // toggle can be reset by the v2 client on join. Recording bots (no streaming_input)
    // must never be live; the in-meeting "Mute mic" control is stable at this point.
    if (!GLOBAL.get().streaming_input) {
      await Promise.race([deactivateMicrophone(page), sleep(2000)])
    }

    // 🎯 CRITICAL: Notify that join was successful (fixes waiting room timeout)
    onJoinSuccess()
    console.log("✅ onJoinSuccess callback called - no more waiting room timeout!")

    // Capture DOM state after successfully joining Teams meeting
    await htmlSnapshot.captureSnapshot(page, "teams_join_meeting_success")

    // Verify audio capture is working (only if streaming is enabled)
    if (GLOBAL.get().streaming_output) {
      try {
        await verifyTeamsAudioCapture(page)
      } catch (error) {
        console.error("[Teams] Failed to verify audio capture post-join:", formatError(error))
      }
    }

    // Check for "Continue without audio or video" that might appear AFTER joining (light interface)
    try {
      console.log('🔄 Post-meeting check for "Continue without audio or video"...')
      for (let i = 0; i < 5; i++) {
        if (cancelCheck?.()) break

        const found = await clickWithInnerText(
          page,
          "button",
          "Continue without audio or video",
          2,
          true
        )
        if (found) {
          console.log('✅ Successfully clicked post-meeting "Continue without audio"')
          await sleep(1500) // Give time for interface to update
          break
        }
        await sleep(800)
      }
    } catch (e) {
      console.warn('Post-meeting "Continue without audio" check failed:', e)
    }

    // Once in the meeting, configure the view
    try {
      // Capture DOM state before configuring Teams view
      await htmlSnapshot.captureSnapshot(page, "teams_configure_view_start")

      if (await clickWithInnerText(page, "button", "View", 10, false)) {
        if (GLOBAL.get().recording_mode !== "gallery_view") {
          await clickWithInnerText(page, "button", "View", 10)
          await clickWithInnerText(page, "div", "Speaker", 20)
        }
      }
    } catch (e) {
      console.error('Error handling "View" or "Speaker" mode:', formatError(e))
    }
  }

  async findEndMeeting(page: Page, _opts?: { ignoreAloneSignals?: boolean }): Promise<boolean> {
    // Teams end-detection (login page / freeze / removed) has no "alone" signal,
    // so _opts.ignoreAloneSignals is not applicable here.
    // Check if we're on a Microsoft login page
    if (await isOnMicrosoftLoginPage(page)) {
      return true
    }

    // Check for page freeze
    try {
      await Promise.race([
        page.evaluate(() => document.readyState),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Page freeze timeout")),
            20000 // 20 seconds timeout like Meet
          )
        )
      ])
    } catch (_e) {
      console.log("Page appears to be frozen for 20 seconds - meeting likely ended")
      return true
    }

    return await isRemovedFromTheMeeting(page)
  }

  async closeMeeting(page: Page): Promise<void> {
    console.log("Attempting to leave the meeting")
    try {
      // Try multiple approaches to find and click the leave button

      // Approach 1: Try to find by aria-label
      // const leaveButton = page.locator('button[aria-label="Leave (⌘+Shift+H)"], button[aria-label*="Leave"]')
      // if (await leaveButton.count() > 0) {
      //     await leaveButton.click()
      //     console.log('Clicked leave button by aria-label')
      //     return
      // }

      // // Approach 2: Try to find by data-tid attribute
      // const hangupButton = page.locator('button[data-tid="hangup-main-btn"]')
      // if (await hangupButton.count() > 0) {
      //     await hangupButton.click()
      //     console.log('Clicked leave button by data-tid')
      //     return
      // }

      // Approach 3: Try to find by text content
      if (await clickWithInnerText(page, "button", "Leave", 5, true)) {
        console.log("Clicked leave button by text content")
        return
      }

      // Approach 4: Try to find by role and name
      const leaveByRole = page.getByRole("button", { name: "Leave" })
      if ((await leaveByRole.count()) > 0) {
        await leaveByRole.click()
        console.log("Clicked leave button by role and name")
        return
      }

      console.log("Could not find leave button, closing page instead")
    } catch (error) {
      console.error("Error while trying to leave meeting:", formatError(error))
    }
  }
}

const INPUT_BOT = 'input[placeholder="Type your name"]'

async function clickWithInnerText(
  page: Page,
  htmlType: string,
  innerText: string,
  iterations: number,
  click = true,
  cancelCheck?: () => boolean
): Promise<boolean> {
  let i = 0
  let continueButton = false

  if (!(await ensurePageLoaded(page))) {
    console.error("Page is not fully loaded at the start.")
    return false
  }

  while (!continueButton && (iterations == null || i < iterations) && !cancelCheck?.()) {
    try {
      if (i % 5 === 0) {
        const isPageLoaded = await ensurePageLoaded(page)
        if (!isPageLoaded) {
          console.error("Page seems frozen or not responding.")
          return false
        }
      }

      // Detect the target button (iframe-aware, exact-text match) WITHOUT
      // clicking here: a DOM .click() inside page.evaluate bypasses Playwright,
      // and therefore CloakBrowser's humanize patches, so the join looks robotic.
      continueButton = await page.evaluate(
        ({ innerText, htmlType, i }) => {
          let elements: Element[] = []
          const iframes = document.querySelectorAll("iframe")

          if (i % 2 === 0 && iframes.length > 0) {
            const firstIframe = iframes[0]
            try {
              const docInIframe = firstIframe.contentDocument || firstIframe.contentWindow?.document
              if (docInIframe) {
                elements = Array.from(docInIframe.querySelectorAll(htmlType))
              }
            } catch (e) {
              console.warn("Iframe access error:", e)
            }
          }

          if (elements.length === 0) {
            elements = Array.from(document.querySelectorAll(htmlType))
          }

          return elements.some((elem) => elem.textContent?.trim() === innerText)
        },
        { innerText, htmlType, i }
      )

      // Click strategy depends on whether humanization is still active:
      //  • During the bot-scored join the page is humanized — CloakBrowser sets
      //    page._original — so click via Playwright (locator.click routes through
      //    the patched frame.click) to get real mouse movement + human timing.
      //  • Once admitted, WaitingRoomState calls dehumanize(), which DELETES
      //    page._original. From then on click via a raw in-page DOM click, which
      //    is instant — the post-join view/layout changes must NOT be slow or
      //    humanized (this was the "layout changes slowly after joining" bug).
      // The DOM click doubles as the reliability fallback when a humanized click
      // can't land during the join.
      if (continueButton && click) {
        const humanizeActive = Boolean((page as unknown as { _original?: unknown })._original)
        const humanized = humanizeActive && (await clickButtonHumanized(page, htmlType, innerText))
        if (!humanized) {
          await page.evaluate(
            ({ innerText, htmlType }) => {
              const el = Array.from(document.querySelectorAll(htmlType)).find(
                (e) => e.textContent?.trim() === innerText
              )
              ;(el as HTMLElement | undefined)?.click()
            },
            { innerText, htmlType }
          )
        }
      }
    } catch (e) {
      if (i === iterations - 1) {
        console.error("Error in clickWithInnerText (last attempt):", formatError(e))
      }
      continueButton = false
    }

    if (!continueButton) {
      // Cap the backoff: the old `100 + i * 100` grew unbounded, so a high iteration
      // count (e.g. 100) waited minutes for a button that was slow or absent. Capped at
      // 500ms per attempt it stays responsive while still yielding between polls.
      await page.waitForTimeout(Math.min(100 + i * 100, 500))
    }

    // Only log if found or on final attempt
    if (continueButton || i === iterations - 1) {
      console.log(`${innerText} ${click ? "clicked" : "found"} : ${continueButton}`)
    }
    i++
  }
  return continueButton
}

/**
 * Click a button by its exact visible text through Playwright's input pipeline
 * (locator.click) so CloakBrowser's humanize patches — real mouse movement and
 * human-like timing — apply during the bot-scored join. Returns false when no
 * actionable match is found/clickable, letting the caller fall back to a raw
 * in-page DOM click for reliability.
 */
async function clickButtonHumanized(
  page: Page,
  htmlType: string,
  innerText: string
): Promise<boolean> {
  // :text-is mirrors the exact-text detection above; :has-text is a fallback for
  // buttons that wrap the label in a child element.
  const selectors = [`${htmlType}:text-is("${innerText}")`, `${htmlType}:has-text("${innerText}")`]
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first()
      if ((await locator.count()) === 0) continue
      await locator.click({ timeout: 2000 })
      return true
    } catch {
      // Try the next strategy, then the caller's DOM-click fallback.
    }
  }
  return false
}

async function typeBotName(page: Page, botName: string, maxAttempts: number): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await page.waitForSelector(INPUT_BOT, { timeout: 1000 })
      const input = page.locator(INPUT_BOT)

      if ((await input.count()) > 0) {
        await input.focus()
        await input.fill(botName)

        // Verify the input value
        const currentValue = await input.inputValue()
        if (currentValue === botName) {
          return
        }

        // If fill didn't work, try typing
        await input.clear()
        await page.keyboard.type(botName, { delay: 100 })

        if ((await input.inputValue()) === botName) {
          return
        }
      }

      await page.waitForTimeout(500)
    } catch (e) {
      console.error(`Error typing bot name (attempt ${i + 1}):`, formatError(e))
    }
  }
  throw new Error("Failed to type bot name")
}

async function isOnMicrosoftLoginPage(page: Page): Promise<boolean> {
  const currentUrl = await page.url()
  if (currentUrl.includes("login.microsoft")) {
    console.log("Detected Microsoft login page, login required")
    GLOBAL.setError(MeetingEndReason.LoginRequired)
    return true
  }
  return false
}

async function isRemovedFromTheMeeting(page: Page): Promise<boolean> {
  try {
    if (!(await ensurePageLoaded(page))) {
      return true
    }

    const raiseButton = page.locator('button#raisehands-button:has-text("Raise")')
    const buttonExists = (await raiseButton.count()) > 0

    // console.log('raiseButton', JSON.stringify(raiseButton))
    // console.log('buttonExists', JSON.stringify(buttonExists))
    if (!buttonExists) {
      console.log("no raise button found, Bot removed from the meeting")
      return true
    }
    return false
  } catch (error) {
    console.error("Error while checking meeting status:", formatError(error))
    return false
  }
}

async function isBotNotAccepted(page: Page): Promise<boolean> {
  // Check if we're on a Microsoft login page
  if (await isOnMicrosoftLoginPage(page)) {
    return true
  }

  // Use unified state detector
  const result = await teamsStateDetector.isDenied(page)
  if (result.matched) {
    const reason =
      (result.pattern && "reason" in result.pattern ? result.pattern.reason : undefined) ??
      MeetingEndReason.BotNotAccepted
    console.log(`Teams denial detected: "${result.matchedText}" -> ${reason}`)
    GLOBAL.setError(reason)
    return true
  }

  return false
}

async function handlePermissionDialog(page: Page): Promise<void> {
  console.log("handling permission dialog")
  try {
    const okButton = page.locator('button:has-text("OK")')
    if ((await okButton.count()) > 0) {
      await okButton.click()
      console.log("Permission dialog handled successfully")
    } else {
      console.log("No permission dialog found")
    }
  } catch (error) {
    console.error("Failed to handle permission dialog:", formatError(error))
  }
}

async function activateCamera(page: Page): Promise<void> {
  console.log("activating camera")
  try {
    // v2 / authenticated Teams client: the toggle is a button labelled "Turn camera on"
    // (aria-label, NOT title). Click it directly when present.
    const v2CameraOn = page.locator('button[aria-label="Turn camera on"]')
    if ((await v2CameraOn.count()) > 0) {
      await v2CameraOn.first().click()
      console.log("Camera turned on (v2 aria-label)")
      await sleep(500)
      return
    }
    // Essayer d'abord l'interface normale de Teams
    const cameraOffText = page.locator('text="Your camera is turned off"')
    if ((await cameraOffText.count()) > 0) {
      const cameraButton = page.locator('button[title="Turn camera on"]')
      if ((await cameraButton.count()) > 0) {
        await cameraButton.click()
        console.log("Camera button clicked successfully (normal interface)")
        await sleep(500)
        return
      }
      console.log("Camera button not found in normal interface, trying light interface")
    }

    // Essayer l'interface light de Teams
    const lightCameraButton = page.locator(
      '[data-tid="toggle-video"][aria-checked="false"], [aria-label="Camera"][aria-checked="false"]'
    )
    if ((await lightCameraButton.count()) > 0) {
      await lightCameraButton.click()
      console.log("Camera button clicked successfully (light interface)")
      await sleep(500)
      return
    }
    console.log("Camera is already on or button not found in both interfaces")
  } catch (error) {
    console.error("Failed to activate camera:", formatError(error))
  }
}

async function isMicrophoneMuted(page: Page): Promise<boolean> {
  // Teams shows unmute mic title when microphone is muted
  const unmuteMicButton = page.locator('button[title="Unmute mic"]')
  if ((await unmuteMicButton.count()) > 0) {
    console.log("[Teams] Microphone is muted")
    return true
  }

  // Teams shows mute mic title when microphone is not muted
  const muteMicButton = page.locator('button[title="Mute mic"]')
  if ((await muteMicButton.count()) > 0) {
    console.log("[Teams] Microphone is not muted")
    return false
  }

  // Default assumption if we cannot determine state
  console.warn("[Teams] Unable to determine microphone state, assuming unmuted")
  return false
}

async function toggleMicrophoneWithShortcut(page: Page): Promise<void> {
  await page.keyboard.down("Control")
  await page.keyboard.down("Shift")
  await page.keyboard.press("KeyM")
  await page.keyboard.up("Shift")
  await page.keyboard.up("Control")
  console.log("Microphone toggle shortcut sent (Ctrl+Shift+M)")
}

async function activateMicrophone(page: Page): Promise<void> {
  console.log("activating microphone")
  try {
    if (!(await isMicrophoneMuted(page))) {
      return
    }
    await toggleMicrophoneWithShortcut(page)

    // Give Teams a moment to apply the state change
    await sleep(500)
  } catch (error) {
    console.error("Failed to activate microphone:", formatError(error))
  }
}

async function deactivateMicrophone(page: Page): Promise<void> {
  console.log("deactivating microphone")
  try {
    if (await isMicrophoneMuted(page)) {
      return
    }
    await toggleMicrophoneWithShortcut(page)

    // Give Teams a moment to apply the state change
    await sleep(500)
  } catch (error) {
    console.error("Failed to deactivate microphone:", formatError(error))
  }
}

async function ensurePageLoaded(page: Page, timeout = 20000): Promise<boolean> {
  try {
    await page.waitForFunction(() => document.readyState === "complete", {
      timeout: timeout
    })
    return true
  } catch (error) {
    console.error("Failed to ensure page is loaded:", formatError(error))
    throw new Error("RetryableError: Page load timeout")
  }
}

// New function to check if we are in the Teams meeting
async function isInTeamsMeeting(page: Page): Promise<boolean> {
  try {
    // First check if denied/not accepted
    if (await isBotNotAccepted(page)) {
      return false
    }

    // Check if Join now button is present (indicates waiting room)
    const joinNowPresent = await clickWithInnerText(page, "button", "Join now", 1, false)
    if (joinNowPresent) {
      return false
    }

    // Use unified state detector for in-meeting indicators
    const result = await teamsStateDetector.isInMeeting(page)
    console.log(
      `Teams meeting presence indicators: ${result.count}/${TEAMS_STATE_CONFIG.inMeetingPattern.selectors.length} visible`
    )

    return result.matched
  } catch (error) {
    console.error("Error checking if in Teams meeting:", formatError(error))
    return false
  }
}
