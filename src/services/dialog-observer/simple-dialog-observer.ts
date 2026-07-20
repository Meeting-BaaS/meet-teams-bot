import type { Locator, Page } from "@playwright/test"
import { GLOBAL } from "../../singleton"
import type { MeetingContext } from "../../state-machine/types"
import { HtmlSnapshotService } from "../html-snapshot-service"
import type { DialogObserverResult } from "./types"

interface DismissTimeouts {
  VISIBLE_TIMEOUT: number
  CLICK_TIMEOUT: number
  PAGE_TIMEOUT: number
}

const TIMEOUTS: DismissTimeouts = {
  VISIBLE_TIMEOUT: 500,
  CLICK_TIMEOUT: 1000,
  PAGE_TIMEOUT: 2000
}

interface ModalPattern {
  name: string
  selector: string
  buttonTexts: string[]
  exitByEscape: boolean
}

/**
 * Google Meet modal patterns.
 * IMPORTANT: Order matters! More specific patterns must come before generic ones
 * to avoid misidentification (e.g., transcription modal matching camera_permission).
 */
const MEET_MODAL_PATTERNS: ModalPattern[] = [
  // People hover dialog (new UI Dec 2025) - dismiss with Escape
  {
    name: "people_hover_dialog",
    selector: 'div[role="dialog"][aria-label*="people in the call" i]:has-text("People")',
    buttonTexts: [], // No buttons to click, just dismiss with Escape
    exitByEscape: true
  },
  // Recording/transcription modals - MUST come first (they may contain "camera"/"microphone" text)
  {
    name: "recording_notification",
    selector: 'div[role="dialog"]:has-text("video call is being recorded"):has(button)',
    buttonTexts: ["Join now"],
    exitByEscape: false
  },
  {
    name: "transcribe_notification",
    selector: 'div[role="dialog"]:has-text("video call is being transcribed"):has(button)',
    buttonTexts: ["Join now"],
    exitByEscape: false
  },
  // Gemini/notes modal
  {
    name: "gemini_notification",
    selector: 'div[role="dialog"]:has-text("Gemini"):has-text("taking notes"):has(button)',
    buttonTexts: ["Join now"],
    exitByEscape: false
  },
  // Privacy/notification modals
  {
    name: "privacy_notification",
    selector: 'div[role="dialog"]:has-text("Others may see"):has(button)',
    buttonTexts: ["Got it", "OK", "Dismiss", "Close"],
    exitByEscape: false
  },
  // Video privacy modals
  {
    name: "video_privacy",
    selector: 'div[role="dialog"]:has-text("video differently"):has(button)',
    buttonTexts: ["Got it", "OK", "Continue"],
    exitByEscape: false
  },
  // Background/feed modals
  {
    name: "background_feed",
    selector:
      'div[role="dialog"]:has-text("background"):has(button), div[role="dialog"]:has-text("feed"):has(button)',
    buttonTexts: ["Got it", "OK", "Dismiss"],
    exitByEscape: false
  },
  // Camera/microphone permission modals - after specific modals to avoid false positives
  // These can be dismissed with Escape key if buttons are not found
  {
    name: "camera_permission",
    selector:
      'div[role="dialog"]:has-text("camera"):has(button), div[role="dialog"]:has-text("microphone"):has(button)',
    buttonTexts: ["Allow", "Block", "Got it", "OK", "Join now"],
    exitByEscape: true
  },
  // Generic dismiss modals (fallback)
  {
    name: "generic_dismiss",
    selector: 'div[role="dialog"]:has(button)',
    buttonTexts: ["Join now", "Got it", "OK", "Dismiss", "Close", "Continue"],
    exitByEscape: false
  }
]

/**
 * Zoom (web client, app.zoom.us/wc) does NOT use Playwright's locator/isVisible
 * path — the rest of the Zoom code (see zoom.ts) documents that Zoom's overlays
 * make Playwright report its own controls as not-visible / not-actionable, so a
 * locator.click() stalls and isVisible() gates skip the element entirely. That is
 * exactly why the pattern-based observer never dismissed the "This meeting is
 * being recorded" modal. Zoom is instead handled by checkAndDismissZoomModals(),
 * which runs a single in-page pass that pierces open shadow roots, ignores
 * Playwright visibility, and clicks with a full pointer/mouse/click sequence so
 * the React handler always fires. Its trigger/acknowledge/never lists live inside
 * that page.evaluate() (browser scope) rather than here.
 */

/**
 * Simplified dialog observer for auto-dismissing in-call modals.
 * Handles Google Meet's notification/permission dialogs and Zoom's
 * "This meeting is being recorded" consent modal via platform-keyed
 * pattern sets sharing a single detect/dismiss code path.
 */
export class SimpleDialogObserver {
  protected context: MeetingContext
  protected dialogObserverInterval?: NodeJS.Timeout

  /**
   * Static flag to temporarily pause the observer (e.g. during layout change)
   * so it doesn't race with intentional Playwright interactions on dialogs we opened.
   */
  private static _paused = false

  /**
   * Instance flag to prevent overlapping observer cycles.
   * setInterval fires every 2s regardless of whether the previous async cycle
   * has completed. Without this guard, multiple cycles run concurrently and
   * contend for the Playwright CDP connection, causing timeouts.
   */
  private isRunning = false

  static pause() {
    SimpleDialogObserver._paused = true
    console.info("[SimpleDialogObserver] Observer paused")
  }

  static resume() {
    SimpleDialogObserver._paused = false
    console.info("[SimpleDialogObserver] Observer resumed")
  }

  /**
   * Manually trigger a single dialog check-and-dismiss cycle.
   * Should be called while the observer is paused (via SimpleDialogObserver.pause())
   * to avoid racing with the periodic observer cycle.
   * Works even when the observer is paused — useful for clearing unexpected
   * dialogs before intentional UI interactions (e.g. layout change).
   */
  async dismissVisibleDialogs(): Promise<DialogObserverResult> {
    if (!this.context.playwrightPage || this.context.playwrightPage.isClosed()) {
      return { found: false, dismissed: false, modalType: null }
    }

    try {
      const result = await this.checkAndDismissModals(this.context.playwrightPage)
      if (result.found) {
        console.info(
          `[SimpleDialogObserver] Manual dismiss: ${result.modalType} - ${result.dismissed ? "dismissed" : "found but not dismissed"}`
        )
      }
      return result
    } catch (error) {
      console.error(`[SimpleDialogObserver] Error in manual dismiss: ${error}`)
      return { found: false, dismissed: false, modalType: null }
    }
  }

  constructor(context: MeetingContext) {
    this.context = context
  }

  setupGlobalDialogObserver() {
    // Start observer for Google Meet and Zoom; no-op on other platforms.
    const platform = GLOBAL.get().meeting_platform
    if (platform !== "meet" && platform !== "zoom") {
      console.info(
        `[SimpleDialogObserver] Observer not started: provider is not Meet or Zoom (${platform})`
      )
      return
    }

    this.stopGlobalDialogObserver()
    this.startGlobalDialogObserver()
  }

  stopGlobalDialogObserver() {
    if (this.dialogObserverInterval) {
      clearInterval(this.dialogObserverInterval)
      this.dialogObserverInterval = undefined
      console.info("[SimpleDialogObserver] Stopped dialog observer")
    }
  }

  protected startGlobalDialogObserver() {
    console.info("[SimpleDialogObserver] Starting dialog observer")
    // Check every 2 seconds for faster modal dismissal during join
    this.dialogObserverInterval = setInterval(this.observer, 2000)
  }

  protected observer = async (): Promise<void> => {
    if (SimpleDialogObserver._paused) {
      return
    }

    // Guard: skip if previous cycle is still running to prevent
    // concurrent Playwright operations from contending on the CDP connection.
    if (this.isRunning) {
      console.info("[SimpleDialogObserver] Previous cycle still running, skipping")
      return
    }
    this.isRunning = true

    try {
      if (!this.context.playwrightPage) {
        console.warn("[SimpleDialogObserver] Cannot start observer: page not available")
        return
      }

      // Check if page is still open before proceeding
      if (this.context.playwrightPage?.isClosed()) {
        console.info("[SimpleDialogObserver] Page closed, stopping observer")
        this.stopGlobalDialogObserver()
        return
      }

      const result = await this.checkAndDismissModals(this.context.playwrightPage)

      if (result.found) {
        console.info(
          `[SimpleDialogObserver] Modal result: ${result.modalType} - ${result.dismissed ? "dismissed" : "found but not dismissed"}`
        )
      }
    } catch (error) {
      // If page is closed, stop the observer
      if (
        error instanceof Error &&
        error.message.includes("Target page, context or browser has been closed")
      ) {
        console.info("[SimpleDialogObserver] Page closed during observer execution, stopping")
        this.stopGlobalDialogObserver()
        return
      }
      console.error(`[SimpleDialogObserver] Error checking dialogs: ${error}`)
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Simplified modal detection. Meet uses the Playwright locator + isVisible
   * pattern loop below. Zoom takes an entirely different in-page path (see
   * checkAndDismissZoomModals and the note above ZOOM patterns) because Zoom's
   * web client defeats Playwright's visibility/actionability checks.
   */
  protected async checkAndDismissModals(
    page: Page,
    customTimeout = 0
  ): Promise<DialogObserverResult> {
    const platform = GLOBAL.get().meeting_platform

    // Zoom: robust in-page dismissal (shadow-piercing, no visibility gate).
    if (platform === "zoom") {
      return this.checkAndDismissZoomModals(page)
    }

    const timeouts =
      customTimeout === 0
        ? TIMEOUTS
        : {
            VISIBLE_TIMEOUT: customTimeout,
            CLICK_TIMEOUT: customTimeout,
            PAGE_TIMEOUT: customTimeout
          }

    const detectionMethod = `simple_${platform}`
    // Meet's ordered pattern set: more specific patterns before generic ones.
    const modalPatterns = MEET_MODAL_PATTERNS

    try {
      for (const pattern of modalPatterns) {
        try {
          // .first(): Zoom's consent modal selector (div:has-text(...)) matches
          // several nested ancestor divs, so a bare locator throws Playwright's
          // strict-mode "resolved to N elements" on isVisible(). Narrowing to the
          // first (outermost) match — which still :has the OK button — makes the
          // check single-element and lets tryDismissModal find the button inside.
          const modal = page.locator(pattern.selector).first()
          const isVisible = await modal.isVisible({
            timeout: timeouts.VISIBLE_TIMEOUT
          })

          if (!isVisible) {
            continue
          }

          console.info(`[SimpleDialogObserver] Found modal: ${pattern.name}`)

          // Capture DOM state before attempting to dismiss modal
          const htmlSnapshot = HtmlSnapshotService.getInstance()
          await htmlSnapshot.captureSnapshot(
            page,
            `dialog_observer_before_dismiss_attempt_${pattern.name}`
          )

          // Try to dismiss the modal by clicking appropriate buttons
          let dismissed = await this.tryDismissModal(modal, pattern.buttonTexts, timeouts)

          // If button click didn't work and exitByEscape is enabled, try Escape key
          if (!dismissed && pattern.exitByEscape) {
            console.info(
              `[SimpleDialogObserver] Button click failed for ${pattern.name}, trying Escape key`
            )
            dismissed = await this.tryDismissWithEscape(page)
          }

          if (dismissed) {
            await page.waitForTimeout(timeouts.PAGE_TIMEOUT)
            return {
              found: true,
              dismissed: true,
              modalType: pattern.name,
              detectionMethod
            }
          }

          return {
            found: true,
            dismissed: false,
            modalType: pattern.name,
            detectionMethod
          }
        } catch (error) {
          console.warn(`[SimpleDialogObserver] Error with pattern ${pattern.name}: ${error}`)
        }
      }

      return { found: false, dismissed: false, modalType: null }
    } catch (error) {
      console.error("[SimpleDialogObserver] Error during modal detection:", error)
      return {
        found: false,
        dismissed: false,
        modalType: "detection_error"
      }
    }
  }

  /**
   * Zoom-only in-page dialog dismissal.
   *
   * Runs ONE pass inside the page (page.evaluate) instead of via Playwright
   * locators, because Zoom's web client makes Playwright report its own modals as
   * not-visible / not-actionable (documented throughout zoom.ts) — which is why
   * the locator/isVisible pattern loop never dismissed the "This meeting is being
   * recorded" modal. The in-page pass:
   *   1. Walks the light DOM AND all open shadow roots (Zoom nests UI in shadow DOM).
   *   2. Considers only acknowledge buttons (OK / Got it / Continue / Dismiss / …)
   *      and never destructive ones (Leave / End / Cancel / Decline / No).
   *   3. Confirms the button belongs to a recording/consent modal (trigger text in
   *      an ancestor, crossing shadow boundaries) OR sits inside a real dialog /
   *      Zoom modal container — so a stray page button is never clicked.
   *   4. Clicks with a full pointerdown→mousedown→mouseup→click→.click() sequence so
   *      whichever event Zoom's React handler listens for fires.
   * Safe by construction: it can only ever click an acknowledge button, so the
   * worst case is a no-op — never a destructive or meeting-exiting action.
   */
  private async checkAndDismissZoomModals(page: Page): Promise<DialogObserverResult> {
    const detectionMethod = "inpage_zoom"
    // Receive-only recorder bots must stay muted; a streaming_input bot speaks and
    // must NOT be re-muted. Read once per cycle (guarded — params are always set
    // by the time the observer runs, but never let this throw the cycle).
    let receiveOnly = true
    try {
      receiveOnly = !GLOBAL.get().streaming_input
    } catch {
      /* params not set yet — default to receive-only (safe: keeps mic muted) */
    }

    try {
      if (page.isClosed()) {
        return { found: false, dismissed: false, modalType: null }
      }

      // Playwright's page.evaluate has NO timeout — a hung/unresponsive page would
      // never resolve, the observer's isRunning guard would never clear, and this
      // bot's watcher would be wedged forever (the "1 of 12 bots never dismissed
      // the modal" symptom). Race the evaluate against a wall clock so a stuck page
      // just skips this cycle and retries on the next tick.
      const evalResult = this.checkZoomInPage(page, receiveOnly)
      const timeout = new Promise<{ modal: string | null; remuted: boolean }>((resolve) =>
        setTimeout(() => resolve({ modal: null, remuted: false }), 8000)
      )
      const { modal, remuted } = await Promise.race([evalResult, timeout])

      if (remuted) {
        console.info("[SimpleDialogObserver] Zoom: re-muted bot mic (was live)")
      }
      if (modal) {
        console.info(`[SimpleDialogObserver] Zoom: dismissed ${modal} (in-page)`)
        return { found: true, dismissed: true, modalType: modal, detectionMethod }
      }
      return { found: false, dismissed: false, modalType: null }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Target page, context or browser has been closed")
      ) {
        return { found: false, dismissed: false, modalType: null }
      }
      console.warn(`[SimpleDialogObserver] Zoom in-page dismissal error: ${error}`)
      return { found: false, dismissed: false, modalType: "detection_error" }
    }
  }

  /**
   * The single in-page pass for Zoom, run every observer tick: (1) dismiss any
   * recording-consent / stray dialog, and (2) re-mute the bot if it went live.
   * Both are needed because dismissing Zoom's "being recorded" modal re-connects
   * audio UNMUTED, and ensureMuted() only runs once at admission — so without a
   * standing re-mute the bot goes live, gets promoted to the active-speaker tile
   * (which blanks the temporal diarization and pins the recording on the bot's own
   * image), and is audible in the meeting. Returns what it did so the caller logs.
   */
  private checkZoomInPage(
    page: Page,
    receiveOnly: boolean
  ): Promise<{ modal: string | null; remuted: boolean }> {
    return page.evaluate<{ modal: string | null; remuted: boolean }, { receiveOnly: boolean }>(
      ({ receiveOnly }) => {
        const TRIGGER =
          /being recorded|may view or share|is being recorded|is being transcribed|consent to/i
        const ACK = /^(ok|okay|got it|continue|i understand|accept|agree|dismiss|close)$/i
        const NEVER = /leave|end\b|cancel|decline|\bno\b|sign out|log out|don't|do not/i

        // Collect every element across the light DOM and all OPEN shadow roots.
        const nodes: Element[] = []
        const walk = (root: Document | ShadowRoot) => {
          for (const el of Array.from(root.querySelectorAll("*"))) {
            nodes.push(el)
            const sr = (el as HTMLElement).shadowRoot
            if (sr) walk(sr)
          }
        }
        walk(document)

        const clean = (s: string | null) => (s || "").replace(/\s+/g, " ").trim()
        // Consider BOTH the visible text and the aria-label so icon-only / labelled
        // buttons (e.g. an OK with the text in an aria-label) still match.
        const isAck = (el: Element) => {
          const txt = clean(el.textContent)
          const aria = clean(el.getAttribute("aria-label"))
          const ok = (s: string) => !!s && ACK.test(s) && !NEVER.test(s)
          return ok(txt) || ok(aria)
        }

        // Zoom PRE-RENDERS a hidden i18n template of this modal elsewhere in the
        // DOM — same "being recorded" text and an OK button. Without a visibility
        // gate the finder matched that GHOST button, clicked a no-op, and reported
        // "dismissed" every tick while the REAL modal stayed up (the false
        // positive). Use getClientRects() — NOT offsetParent, which is null for the
        // position:fixed modal even when it's visible — plus the computed-style
        // checks, so we only ever act on the actually-visible control.
        const isVisible = (el: Element) => {
          if (!el.getClientRects().length) return false
          const s = getComputedStyle(el)
          return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity || "1") > 0
        }

        // Hop up the ancestor chain, crossing shadow-root boundaries via host.
        const parentAcross = (el: Element): Element | null => {
          if (el.parentElement) return el.parentElement
          const root = el.getRootNode()
          return root instanceof ShadowRoot ? root.host : null
        }

        const clickHard = (btn: Element) => {
          const opts: MouseEventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window
          }
          try {
            btn.dispatchEvent(new PointerEvent("pointerdown", opts))
          } catch {}
          btn.dispatchEvent(new MouseEvent("mousedown", opts))
          try {
            btn.dispatchEvent(new PointerEvent("pointerup", opts))
          } catch {}
          btn.dispatchEvent(new MouseEvent("mouseup", opts))
          btn.dispatchEvent(new MouseEvent("click", opts))
          ;(btn as HTMLElement).click?.()
        }

        const ackButtons = nodes.filter(
          (el) =>
            (el.tagName === "BUTTON" || el.getAttribute("role") === "button") &&
            isAck(el) &&
            isVisible(el)
        )

        let modal: string | null = null

        // Pass 1: acknowledge button tied to a recording/consent modal via ancestor text.
        for (const btn of ackButtons) {
          let node: Element | null = btn
          let hops = 0
          while (node && hops < 10) {
            if (TRIGGER.test(node.textContent || "")) {
              clickHard(btn)
              modal = "zoom_recording_consent"
              break
            }
            node = parentAcross(node)
            hops++
          }
          if (modal) break
        }

        // Pass 2: acknowledge button inside any real dialog / Zoom modal container.
        if (!modal) {
          const inDialog = (el: Element): boolean => {
            let node: Element | null = el
            let hops = 0
            while (node && hops < 10) {
              const role = node.getAttribute("role")
              const cls = typeof node.className === "string" ? node.className : ""
              if (
                role === "dialog" ||
                role === "alertdialog" ||
                /zm-modal|zmu-modal|zm-dialog|ReactModal__Content/i.test(cls)
              ) {
                return true
              }
              node = parentAcross(node)
              hops++
            }
            return false
          }
          for (const btn of ackButtons) {
            if (inDialog(btn)) {
              clickHard(btn)
              modal = "zoom_generic_dialog"
              break
            }
          }
        }

        // Standing mute enforcement for receive-only recorders. Zoom re-connects
        // audio UNMUTED after the recording-consent modal and ensureMuted only runs
        // once at admission, so re-mute every tick. Find the mic toggle across the
        // light DOM AND open shadow roots (reuse the walked `nodes`) — a plain
        // querySelector on #foot-bar/.footer missed it on the layout where Zoom
        // nests the footer in a shadow root, which is why the occasional bot stayed
        // live. Match the self control by its "microphone" aria-label ("mute my
        // microphone" live / "unmute my microphone" muted), falling back to a bare
        // "mute"/"unmute" button. Click ONLY when live, and a SINGLE plain click
        // (never the multi-event clickHard — a toggle clicked twice flips straight
        // back). No-op in the waiting room / for streaming bots.
        let remuted = false
        if (receiveOnly) {
          const micLabel = (el: Element) => (el.getAttribute("aria-label") || "").toLowerCase()
          // Same visibility gate — Zoom's hidden template ships a ghost mic button too.
          const buttons = nodes.filter(
            (el) =>
              (el.tagName === "BUTTON" || el.getAttribute("role") === "button") && isVisible(el)
          )
          const mic =
            buttons.find((el) => micLabel(el).includes("microphone")) ||
            buttons.find((el) => /^\s*(un)?mute\s*$/.test(micLabel(el)))
          if (mic) {
            const ml = micLabel(mic)
            if (ml.includes("mute") && !ml.includes("unmute")) {
              ;(mic as HTMLElement).click()
              remuted = true
            }
          }
        }

        return { modal, remuted }
      },
      { receiveOnly }
    )
  }

  /**
   * Try to dismiss a modal by pressing the Escape key
   */
  private async tryDismissWithEscape(page: Page): Promise<boolean> {
    try {
      await page.keyboard.press("Escape")
      console.info("[SimpleDialogObserver] Pressed Escape key to dismiss modal")
      return true
    } catch (error) {
      console.warn(`[SimpleDialogObserver] Error pressing Escape key: ${error}`)
      return false
    }
  }

  /**
   * Try to dismiss a modal by clicking appropriate buttons within the modal.
   * Uses locator-based finding (same as before) but clicks via evaluate()
   * (direct DOM click) instead of Playwright's coordinate-based click.
   * This bypasses actionability checks so it works even when the button
   * is behind the video overlay or hidden by the HTML cleaner.
   */
  private async tryDismissModal(
    modal: Locator,
    buttonTexts: string[],
    timeouts: DismissTimeouts
  ): Promise<boolean> {
    // Only search within the modal, not the entire page
    for (const buttonText of buttonTexts) {
      try {
        // Try exact text match first
        let button = modal.locator(`button:has-text("${buttonText}")`)
        let buttonCount = await button.count()

        if (
          buttonCount > 0 &&
          (await button.first().isVisible({ timeout: timeouts.VISIBLE_TIMEOUT }))
        ) {
          console.info(`[SimpleDialogObserver] Clicking button: "${buttonText}"`)
          await button
            .first()
            .evaluate((el: HTMLElement) => el.click(), { timeout: timeouts.CLICK_TIMEOUT })
          return true
        }

        // Try partial text match
        button = modal.locator(`button:text-matches(".*${buttonText}.*", "i")`)
        buttonCount = await button.count()

        if (
          buttonCount > 0 &&
          (await button.first().isVisible({ timeout: timeouts.VISIBLE_TIMEOUT }))
        ) {
          console.info(`[SimpleDialogObserver] Clicking button (partial match): "${buttonText}"`)
          await button
            .first()
            .evaluate((el: HTMLElement) => el.click(), { timeout: timeouts.CLICK_TIMEOUT })
          return true
        }

        // Try span content (for Material Design buttons)
        button = modal.locator(`button span:has-text("${buttonText}")`)
        buttonCount = await button.count()

        if (
          buttonCount > 0 &&
          (await button.first().isVisible({ timeout: timeouts.VISIBLE_TIMEOUT }))
        ) {
          console.info(`[SimpleDialogObserver] Clicking button (span): "${buttonText}"`)
          // Navigate to parent button element and click via evaluate
          const parentButton = button.first().locator("xpath=..")
          await parentButton.evaluate((el: HTMLElement) => el.click(), {
            timeout: timeouts.CLICK_TIMEOUT
          })
          return true
        }

        // Try aria-label (for icon-only buttons like Meet's "Close" X on the
        // Adjust view dialog, which has aria-label="Close" but no visible text).
        // Case-insensitive to tolerate Meet UI variants.
        button = modal.locator(`button[aria-label="${buttonText}" i]`)
        buttonCount = await button.count()

        if (
          buttonCount > 0 &&
          (await button.first().isVisible({ timeout: timeouts.VISIBLE_TIMEOUT }))
        ) {
          console.info(`[SimpleDialogObserver] Clicking button (aria-label): "${buttonText}"`)
          await button
            .first()
            .evaluate((el: HTMLElement) => el.click(), { timeout: timeouts.CLICK_TIMEOUT })
          return true
        }
      } catch (error) {
        console.warn(`[SimpleDialogObserver] Error trying button "${buttonText}": ${error}`)
      }
    }
    return false
  }
}
