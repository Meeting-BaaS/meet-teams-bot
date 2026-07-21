import type { Page } from "@playwright/test"
import { GLOBAL } from "../../singleton"
import type { RecordingMode } from "../../types"

/**
 * Per-tick snapshot of the cleaner's invariants, mirrored out of the page so the
 * Node side can log a checklist and warn when something never clears. Booleans are
 * tri-state: `null` = "not applicable right now" (e.g. no share in progress).
 */
interface CleanerStatus {
  /** ms since the cleaner started (for deadline checks on the Node side). */
  ageMs: number
  /** The recording-fix <style> is present in <head>. Self-healed if it goes missing. */
  styleInjected: boolean
  /** The meeting video surface (#video-share-layout video-player) is actually mounted. */
  videoSurface: boolean
  /** A named avatar footer matching the bot's own name was found this tick. */
  botTilePresent: boolean
  /** The bot's own <video-player> was found and forced invisible this tick. */
  botTileHidden: boolean
  /** A non-bot speaker tile was selected and pinned to the frame (speaker view). */
  speakerPinned: boolean
  /** Some content is pinned to the recorded frame: a share, or a non-bot speaker tile. */
  contentPinned: boolean
  /** A real screen share is on screen and pinned. */
  shareActive: boolean
  /** Zoom chrome (footer/header/toasts/chat panel) is hidden from the frame. */
  chromeHidden: boolean
}

declare global {
  interface Window {
    zoomHtmlCleanerInterval?: NodeJS.Timeout
    zoomCleanerLog?: (msg: string) => void
    __baasCleanerStatus?: CleanerStatus
    __baasForceClean?: () => void
  }
}

/**
 * Zoom Web recording cleaner — hides the browser-client chrome (footer toolbar,
 * header, reaction/notification toasts, "you are viewing" banners) so the ffmpeg
 * x11grab capture shows the video tiles / active speaker, not Zoom's UI, and never
 * the bot's OWN branding tile.
 *
 * Runs as a self-verifying interval loop. Every tick it (a) re-asserts every rule
 * (self-healing: styles are re-injected if Zoom wipes them, the bot's own tile is
 * re-hidden wherever Zoom moved it), and (b) writes a CleanerStatus checklist to
 * window.__baasCleanerStatus. The Node side polls that checklist, logs it when it
 * changes, and WARNs if the core invariants never clear — so a wrong end-state is
 * loud instead of silent. This is the fix for "the cleaner never fails but the
 * recording is wrong": the invariants are now observable and continuously enforced.
 */
export class ZoomHtmlCleaner {
  private page: Page
  private recordingMode: RecordingMode
  private statusPoller?: NodeJS.Timeout

  constructor(page: Page, recordingMode: RecordingMode) {
    this.page = page
    this.recordingMode = recordingMode
  }

  public async start(): Promise<void> {
    console.log("[Zoom] Starting HTML cleaner")
    // The bot's own display name — used to hide the bot's OWN video tile (its
    // branding image) from the recording no matter where Zoom places it. Guarded
    // so a missing/late singleton can never throw and abort the cleaner.
    const botName = (() => {
      try {
        return GLOBAL.get().bot_name ?? ""
      } catch {
        return ""
      }
    })()

    // Bridge in-page cleaner diagnostics to the bot log. In-page console.log is
    // dropped unless LOG_LEVEL=debug, so route through an exposed function like the
    // speaker observer.
    await this.page
      .exposeFunction("zoomCleanerLog", (msg: string) => console.log(msg))
      .catch(() => { })

    await this.page.evaluate((botName: string) => {
      const clog = (m: string) => {
        try {
          window.zoomCleanerLog?.(m)
        } catch {
          /* bridge unavailable */
        }
      }

      const START = Date.now()

      const HIDE_SELECTORS = [
        ".footer",
        "#foot-bar",
        ".footer__inner",
        "#wc-footer",
        ".full-screen-icon",
        ".meeting-header",
        "#meeting-header",
        ".meeting-info-container",
        ".notification-message-wrap",
        ".toast-list",
        ".sharee-container__viewing-status",
        // Screen-share sharing-indicator tip + the "View Options" control that Zoom
        // overlays on a shared screen. These are small overlays — the shared screen
        // itself (#sharee-container / .sharee-container__canvas) is left untouched.
        ".sharee-sharing-indicator__tip",
        ".sharee-container__indicator", // "You are viewing X's screen" bar atop the share
        ".sharee-container__canvas-outline", // green/blue focus outline around the share
        "#sharingViewOptions",
        "#anno-entrance-btn", // annotation toolbar entry that appears over a share
        '[role="tooltip"]',
        // During a screen share Zoom renders the active speaker as a floating tile
        // inside a modal portal in the left container — a bot-only artifact (you
        // don't see it as a normal viewer). Hide the portal; the shared screen
        // (#sharee-container) is elsewhere and untouched.
        "#wc-container-left .ReactModalPortal",
        ".new-caption-box", // live-caption overlay
        ".reaction-animate-container",
        ".zmwebsdk-makeStyles-toast-1",
        // The chat panel is deliberately held OPEN for the whole meeting —
        // Zoom only mounts the message list while it's open, so closing it would
        // kill chat capture. Hide it visually instead. opacity (not display) is
        // essential: unmounting the panel would unmount the messages with it.
        ".chat-container",
        "#chat-container",
        '[aria-label="Chat Message List"]'
      ]

      // Selectors for a Zoom "video frame" (the container that wraps one tile's
      // <video-player>). Used to scope the bot-tile hide to the bot's OWN frame so
      // we never accidentally grab a neighbouring tile's player.
      const FRAME_SEL =
        ".speaker-active-container__video-frame," +
        ".single-main-container__video-frame," +
        ".single-suspension-container__video-frame," +
        ".speaker-bar-container__video-frame," +
        "[class*='video-frame']"

      const norm = (s: string) =>
        s
          .replace(/\s*\((host|co-host|cohost|me|guest)[^)]*\)\s*/gi, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
      const botTarget = norm(botName)

      // ── Rule 1: the recording-fix stylesheet. Injected via a function so we can
      // re-inject it every tick if Zoom's SPA ever tears down <head> children.
      const STYLE_ID = "baas-zoom-rec-fix"
      const STYLE_TEXT = [
        // ── Speaker view ONLY (no share) ──────────────────────────────────
        // Active-speaker video fills the recorded frame. Scoped with
        // :not(.video-share-standrad): during a share #video-share-layout gains
        // that class, and pinning its video-players there is what stacked/offset
        // the recording. So this rule switches OFF automatically once a share starts.
        "#video-share-layout:not(.video-share-standrad) video-player {",
        "  position: fixed !important; inset: 0 !important;",
        "  top: 0 !important; left: 0 !important;",
        "  width: 100vw !important; height: 100vh !important;",
        "  z-index: 2147483000 !important;",
        "}",
        "#video-share-layout:not(.video-share-standrad) video-player video {",
        "  width: 100% !important; height: 100% !important;",
        "  object-fit: cover !important;",
        "}",
        // DETERMINISTIC RULE: exactly ONE tile is visible — the winner
        // (.baas-active-tile), pinned full-frame below. EVERY other video-player is
        // forced invisible, so nothing can bleed into the recording: not the bot's own
        // camera, not Zoom's FOOTERLESS self-view main tile (a node with no name that
        // hideBotTile can't identify), not other participants. This replaces the old
        // "pin everything + boost the main tile + fight z-index" approach, under which a
        // boosted footerless self-view tile painted its camera (branding / fake-camera
        // colours) right over the chosen speaker.
        "#video-share-layout:not(.video-share-standrad) video-player:not(.baas-active-tile) {",
        "  opacity: 0 !important; visibility: hidden !important;",
        "}",
        // ── Speaker-bar strip — hidden from the recording in BOTH modes ────
        // The horizontal strip of participant tiles is clutter over the main
        // content. opacity:0 keeps it in the DOM so the speaker observer can still
        // read .speaker-bar-container__video-frame--active.
        '[class*="speaker-bar-container"] { opacity: 0 !important; }',
        // ── Bot's own tile — belt-and-suspenders CSS hook. hideBotTile() sets the
        // real inline hide (identity match); this class is toggled with it so the
        // whole tile (not just the video) collapses out of the frame.
        ".baas-bot-tile, .baas-bot-tile video-player { opacity: 0 !important; visibility: hidden !important; }",
        // ── Deterministic speaker pin. Every tick, JS picks the ONE tile to record
        // (Zoom's active-speaker slot if it isn't the bot; otherwise the best
        // non-bot tile) and marks its <video-player> `.baas-active-tile`. This wins
        // over the blanket pin (2147483000) and the active-container boost
        // (2147483010), so the recorded frame tracks the human speaker instead of
        // whichever tile Zoom/DOM-order/z-index happens to surface — the fix for the
        // brand appearing even with a camera on (bot's mic leaks → Zoom promotes the
        // bot into its own active-speaker slot). `.baas-show-container` un-hides the
        // specific speaker-bar strip the winner lives in (the strip is opacity:0 by
        // default, and a parent's opacity:0 would otherwise hide the winner too).
        ".baas-show-container { opacity: 1 !important; }",
        "#video-share-layout:not(.video-share-standrad) video-player.baas-active-tile {",
        "  position: fixed !important; inset: 0 !important;",
        "  top: 0 !important; left: 0 !important;",
        "  width: 100vw !important; height: 100vh !important;",
        "  z-index: 2147483015 !important;",
        "  opacity: 1 !important; visibility: visible !important;",
        "}",
        "#video-share-layout:not(.video-share-standrad) video-player.baas-active-tile video {",
        "  width: 100% !important; height: 100% !important; object-fit: cover !important;",
        "}",
        // Kill Zoom's green "talking" indicator on the promoted tile. When the winner
        // is a thumbnail (bar-active), only its <video-player> is pinned full-frame;
        // the frame itself stays at its small size with Zoom's active-speaker border
        // (a CSS border/box-shadow, no DOM node) — which then floats in the frame as a
        // green rectangle. Neutralise border/shadow/outline (and any ::before/::after
        // indicator) on the winner's frame and its descendants.
        ".baas-winner-frame, .baas-winner-frame * {",
        "  box-shadow: none !important; outline: none !important; border-color: transparent !important;",
        "}",
        ".baas-winner-frame::before, .baas-winner-frame::after,",
        ".baas-winner-frame *::before, .baas-winner-frame *::after {",
        "  box-shadow: none !important; outline: none !important; border-color: transparent !important; background: transparent !important;",
        "}",
        // The winner frame's only children are the <video-player> (pinned full-frame
        // via .baas-active-tile) and a .video-avatar__avatar overlay (name footer +
        // mute icon + the avatar/loading badge). Once the video is relocated to the
        // full frame, that overlay is orphaned at the thumbnail's small top-center
        // position and shows as a stray blue "…" / green-bordered box in the
        // recording. Hide every non-video child of the winner frame. textContent
        // stays readable for the speaker observer (visibility:hidden doesn't strip it).
        ".baas-winner-frame > *:not(video-player) {",
        "  opacity: 0 !important; visibility: hidden !important;",
        "}",
        // ── Share view — pin the shared screen to fill the frame ──────────
        "html.baas-share-active #sharee-container {",
        "  position: fixed !important; inset: 0 !important;",
        "  top: 0 !important; left: 0 !important;",
        "  width: 100vw !important; height: 100vh !important;",
        "  z-index: 2147483020 !important; background: #000 !important;",
        "}",
        "html.baas-share-active #sharee-container .sharee-container__viewport {",
        "  position: absolute !important; inset: 0 !important;",
        "  top: 0 !important; left: 0 !important; margin: 0 !important;",
        "  transform: none !important;",
        "  width: 100% !important; height: 100% !important;",
        "  display: flex !important; align-items: center !important; justify-content: center !important;",
        "}",
        "html.baas-share-active #sharee-container .sharee-container__canvas {",
        "  position: relative !important; inset: auto !important;",
        "  top: auto !important; left: auto !important; margin: auto !important;",
        "  max-width: 100% !important; max-height: 100% !important;",
        "}",
        // Hide the participant name/badge overlay everywhere — the recording shows
        // video only, never a name label, mute icon, or the coloured avatar/initials
        // badge (which Zoom shows when a camera is off). opacity:0 keeps the footer
        // text in the DOM so the speaker observer can still read names from it.
        ".video-avatar__avatar, .video-avatar__avatar-footer { opacity: 0 !important; }",
        // The speaker observer opens the participants pane to read the roster. Force
        // it OFF-SCREEN and out of flow so it never appears in the recording and
        // never squeezes the video — but keep it rendered so names stay readable.
        "#wc-container-right {",
        "  position: fixed !important; left: -100000px !important; top: 0 !important;",
        "  width: 360px !important; height: 100vh !important;",
        "  opacity: 0 !important; pointer-events: none !important; z-index: -1 !important;",
        "}"
      ].join("\n")

      const ensureStyle = (): boolean => {
        let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
        if (!style) {
          style = document.createElement("style")
          style.id = STYLE_ID
          style.textContent = STYLE_TEXT
          document.head.appendChild(style)
          return true
        }
        return true
      }

      // ── Rule 2: hide Zoom chrome. Returns whether the key chrome (footer) is
      // actually out of the frame, for the checklist.
      const hideChrome = (): boolean => {
        for (const sel of HIDE_SELECTORS) {
          document.querySelectorAll(sel).forEach((el) => {
            ; (el as HTMLElement).style.opacity = "0"
          })
        }
        const footer = document.querySelector(".footer, #foot-bar") as HTMLElement | null
        if (!footer) return true
        const s = getComputedStyle(footer)
        return s.opacity === "0" || s.visibility === "hidden" || s.display === "none"
      }

      // ── Rule 3: hide the bot's OWN video tile. The recording must never show the
      // bot's camera (its branding image). Zoom sometimes promotes the bot's tile
      // into the MAIN speaker area (when the bot is the only live camera — i.e.
      // every human is audio-only), and the z-index boost above would otherwise
      // lift the brand to the top. Match the tile by its name-footer (== the bot's
      // display name), scope to its OWN frame, and force the <video-player>
      // invisible. Idempotent, runs every tick, follows Zoom's layout changes.
      const hideBotTile = (): { present: boolean; hidden: boolean } => {
        // Clear last tick's marker so a tile that stopped being the bot is released.
        document.querySelectorAll(".baas-bot-tile").forEach((el) => el.classList.remove("baas-bot-tile"))
        if (!botTarget) return { present: false, hidden: false }
        let present = false
        let hidden = false
        document.querySelectorAll(".video-avatar__avatar-footer").forEach((footer) => {
          const span = footer.querySelector("span")
          if (norm(span?.textContent || footer.textContent || "") !== botTarget) return
          present = true
          const frame = (footer as Element).closest(FRAME_SEL) as HTMLElement | null
          const scope: Element = frame || (footer.parentElement as Element) || (footer as Element)
          const vp = scope.querySelector("video-player") as HTMLElement | null
          if (vp) {
            scope.classList.add("baas-bot-tile")
            vp.style.opacity = "0"
            vp.style.visibility = "hidden"
            hidden = true
          }
        })
        return { present, hidden }
      }

      // ── Rule 4: share detection → toggles `html.baas-share-active`. Keyed on the
      // ACTUAL rendered canvas size (not merely the presence of #sharee-container,
      // which Zoom also mounts empty at 0x0), so the full-frame black pin can only
      // apply while a real share is on screen.
      let shareActive = false
      const updateShareState = (): boolean => {
        const canvas = document.querySelector(".sharee-container__canvas") as HTMLElement | null
        const r = canvas?.getBoundingClientRect()
        const active = !!r && r.width > 200 && r.height > 150
        if (active !== shareActive) {
          shareActive = active
          document.documentElement.classList.toggle("baas-share-active", active)
          clog(active ? "[Zoom] Screen share detected — pinned to frame" : "[Zoom] Screen share ended")
        }
        return shareActive
      }

      // ── Rule 5: deterministic speaker selection. Speaker view must always show
      // the active speaker and NEVER the bot. Rather than trusting Zoom's DOM order
      // + z-index (which surfaces the bot whenever its mic leaks and Zoom promotes
      // it into the active-speaker slot), we pick the winning tile ourselves, in
      // priority order, always skipping the bot's own tile, and pin exactly that one
      // full-frame via `.baas-active-tile`.
      const isBotFrame = (frame: Element): boolean => {
        if (!botTarget) return false
        const footer = frame.querySelector(".video-avatar__avatar-footer")
        if (!footer) return false
        const span = footer.querySelector("span")
        return norm(span?.textContent || footer.textContent || "") === botTarget
      }
      // The tile we RECORD. Order matters: `.speaker-bar-container__video-frame--active`
      // is Zoom's REAL "talking now" marker and tracks the speaker; the big
      // `.speaker-active-container__video-frame` can be a fixed/pinned slot that never
      // moves (observed frozen on one node the whole call), so it comes AFTER bar-active
      // as a fallback for layouts with no strip (1-on-1, gallery). The speaker OBSERVER
      // reads its active-speaker name from the SAME winner we pin here (`.baas-winner-frame`),
      // so the recorded face and the transcript label are literally the same element and
      // can never diverge. No "any thumbnail" catch-all: that pinned a FIXED first tile
      // that never tracks the speaker. If no marker resolves to a non-bot tile we pin
      // nothing (bot stays hidden regardless).
      const WINNER_TIERS = [
        ".speaker-bar-container__video-frame--active",
        ".speaker-active-container__video-frame",
        ".single-main-container__video-frame",
        ".single-suspension-container__video-frame",
        ".gallery-video-container__video-frame--active"
      ]
      const clearWinnerMarks = () => {
        document.querySelectorAll(".baas-active-tile").forEach((e) => e.classList.remove("baas-active-tile"))
        document.querySelectorAll(".baas-show-container").forEach((e) => e.classList.remove("baas-show-container"))
        document.querySelectorAll(".baas-winner-frame").forEach((e) => e.classList.remove("baas-winner-frame"))
      }
      const nodeId = (frame: Element | null): string =>
        (frame?.querySelector("video-player") as HTMLElement | null)?.getAttribute("node-id") ?? "-"

      // Picks the non-bot tile to record and pins it. Returns the winning selector +
      // <video-player> (for diagnostics), or nulls if nothing was pinned. No-op
      // during a share — the share canvas owns the frame then.
      const pinActiveSpeaker = (
        shareOn: boolean
      ): { sel: string | null; vp: HTMLElement | null } => {
        clearWinnerMarks()
        if (shareOn) return { sel: null, vp: null }
        const layout = document.querySelector("#video-share-layout")
        if (!layout) return { sel: null, vp: null }
        let winner: HTMLElement | null = null
        let winnerSel: string | null = null
        for (const sel of WINNER_TIERS) {
          const frame = Array.from(layout.querySelectorAll(sel)).find((f) => {
            if (isBotFrame(f)) return false
            // Require a REAL participant name footer. A footerless tile (Zoom's own
            // self-view of the bot's camera — node #1, no name) must never be recorded.
            const footer = f.querySelector(".video-avatar__avatar-footer")
            const span = footer?.querySelector("span")
            if (!norm(span?.textContent || footer?.textContent || "")) return false
            return !!f.querySelector("video-player")
          })
          const vp = frame?.querySelector("video-player") as HTMLElement | null
          if (vp) {
            winner = vp
            winnerSel = sel
            break
          }
        }
        if (!winner) return { sel: null, vp: null }
        winner.classList.add("baas-active-tile")
        // Mark the winner's frame so its green "talking" border/box-shadow is killed
        // (see .baas-winner-frame CSS) — otherwise a promoted thumbnail's active border
        // floats in the recorded frame as a green rectangle.
        const winnerFrame = winner.closest(FRAME_SEL)
        if (winnerFrame) winnerFrame.classList.add("baas-winner-frame")
        // Un-hide the specific speaker-bar strip the winner sits in (it's opacity:0
        // by default, and a parent's group-opacity would otherwise hide the winner).
        let el: Element | null = winner.parentElement
        while (el && el !== document.body) {
          if (/speaker-bar-container/.test(el.className || "")) el.classList.add("baas-show-container")
          el = el.parentElement
        }
        return { sel: winnerSel, vp: winner }
      }

      // ── Speaker-tracking diagnostics. Logs (by node-id — never names, matching
      // the observer's privacy rule) which tile the recording is pinned to vs which
      // tiles Zoom marks active, on every change, and WARNs if the recorded tile
      // stays put while Zoom's active-speaker marker keeps moving (the "stuck on one
      // speaker" symptom). Gives a test run everything needed to see the tracking.
      const SHORT: Record<string, string> = {
        ".speaker-active-container__video-frame": "active",
        ".speaker-bar-container__video-frame--active": "bar-active",
        ".single-main-container__video-frame": "main",
        ".single-suspension-container__video-frame": "suspension",
        ".gallery-video-container__video-frame--active": "gallery-active"
      }
      let diagSig = ""
      let stuckWinId = ""
      let stuckWinSince = Date.now()
      let stuckBarId = ""
      let barMovesSinceWin = 0
      let warnedStuck = false
      const diag = (winnerSel: string | null, winnerVp: HTMLElement | null) => {
        const winId = winnerVp?.getAttribute("node-id") ?? "-"
        const acId = nodeId(document.querySelector(".speaker-active-container__video-frame"))
        const barId = nodeId(document.querySelector(".speaker-bar-container__video-frame--active"))
        const mainId = nodeId(document.querySelector(".single-main-container__video-frame"))
        const sig = `${SHORT[winnerSel ?? ""] ?? "-"}#${winId}|ac${acId}|bar${barId}|main${mainId}`
        if (sig !== diagSig) {
          diagSig = sig
          clog(
            `[Zoom][speaker-pin] recording=${SHORT[winnerSel ?? ""] ?? "none"}#${winId} ` +
            `zoom-active=#${acId} bar-active=#${barId} main=#${mainId}`
          )
        }
        // Stuck detector: winner node-id constant while the bar-active node-id moves.
        if (winId !== stuckWinId) {
          stuckWinId = winId
          stuckWinSince = Date.now()
          barMovesSinceWin = 0
          warnedStuck = false
        }
        if (barId !== stuckBarId) {
          stuckBarId = barId
          if (barId !== "-") barMovesSinceWin++
        }
        // Log-only diagnostic. We already pin bar-active first, so there's nothing
        // better to switch to here — but if the pinned tile stays put while Zoom's
        // --active marker keeps moving, surface it so a stuck recording is visible in
        // the logs rather than silent.
        if (
          !warnedStuck &&
          winId !== "-" &&
          Date.now() - stuckWinSince > 8000 &&
          barMovesSinceWin >= 3 &&
          winId !== barId &&
          barId !== "-"
        ) {
          warnedStuck = true
          clog(
            `[Zoom][speaker-pin] ⚠️ recorded tile #${winId} unchanged for ${Math.round(
              (Date.now() - stuckWinSince) / 1000
            )}s while Zoom's active-speaker marker moved ${barMovesSinceWin}× (now bar #${barId}) ` +
            `— recording may be stuck on one speaker`
          )
        }
      }

      const clean = () => {
        const styleInjected = ensureStyle()
        const chromeHidden = hideChrome()
        const bot = hideBotTile()
        const shareOn = updateShareState()
        const pin = pinActiveSpeaker(shareOn)
        const speakerPinned = !!pin.vp
        diag(pin.sel, pin.vp)
        const videoSurface = !!document.querySelector("#video-share-layout video-player")
        const contentPinned = shareOn || speakerPinned

        const status: CleanerStatus = {
          ageMs: Date.now() - START,
          styleInjected,
          videoSurface,
          botTilePresent: bot.present,
          botTileHidden: bot.hidden,
          speakerPinned,
          contentPinned,
          shareActive: shareOn,
          chromeHidden
        }
        window.__baasCleanerStatus = status
      }

      clean()
      window.zoomHtmlCleanerInterval = setInterval(clean, 500)
      // Exposed so the Node-side checklist can force an immediate re-clean the moment
      // it detects an anomaly, instead of waiting for the next 500ms tick.
      window.__baasForceClean = clean
    }, botName)

    // ── Node-side checklist log. Poll the in-page status every 2s, log a compact
    // one-line checklist whenever it changes, and WARN if the core invariants
    // (video surface mounted, and — when the bot's tile is present — the brand
    // hidden) never clear within the deadline. This is the "checklist log + better
    // in-meeting indicators" that makes a wrong end-state loud instead of silent.
    const SURFACE_DEADLINE_MS = 20000
    let lastSig = ""
    let warnedSurface = false
    let warnedBrand = false
    this.statusPoller = setInterval(() => {
      this.page
        .evaluate(() => window.__baasCleanerStatus ?? null)
        .then((st: CleanerStatus | null) => {
          if (!st) return
          const tick = (b: boolean) => (b ? "✓" : "✗")
          const botCell = !st.botTilePresent
            ? "n/a"
            : st.botTileHidden
              ? "hidden"
              : "VISIBLE"
          const sig = [
            tick(st.videoSurface),
            tick(st.speakerPinned),
            tick(st.contentPinned),
            botCell,
            tick(st.shareActive),
            tick(st.chromeHidden),
            tick(st.styleInjected)
          ].join("|")
          if (sig !== lastSig) {
            lastSig = sig
            console.log(
              `[Zoom][cleaner-check] surface=${tick(st.videoSurface)} ` +
              `speaker=${tick(st.speakerPinned)} content=${tick(st.contentPinned)} ` +
              `botTile=${botCell} share=${tick(st.shareActive)} ` +
              `chrome=${tick(st.chromeHidden)} style=${tick(st.styleInjected)}`
            )
          }
          if (!warnedSurface && !st.videoSurface && st.ageMs > SURFACE_DEADLINE_MS) {
            warnedSurface = true
            console.warn(
              `[Zoom][cleaner-check] ⚠️ video surface not mounted after ${Math.round(
                st.ageMs / 1000
              )}s — recording may be blank`
            )
          }
          // Brand-in-frame is the failure that produced the stuck-on-branding
          // recordings: the bot's tile is present but not hidden. hideBotTile runs
          // every 500ms so this should self-clear; warn once if it ever persists.
          if (!warnedBrand && st.botTilePresent && !st.botTileHidden && st.ageMs > 5000) {
            warnedBrand = true
            console.warn(
              "[Zoom][cleaner-check] ⚠️ bot's own tile present but not hidden — brand may be in the recorded frame"
            )
          }
          // Active repair: if the checklist sees anything off — the style wiped, the
          // bot tile not hidden, or the surface up with no speaker pinned — force an
          // immediate re-clean instead of waiting for the next 500ms tick. The clean
          // routine is fully idempotent, so re-running it is always safe.
          const anomaly =
            !st.styleInjected ||
            (st.botTilePresent && !st.botTileHidden) ||
            (st.videoSurface && !st.contentPinned)
          if (anomaly) {
            this.page.evaluate(() => window.__baasForceClean?.()).catch(() => { })
          }
        })
        .catch(() => { })
    }, 2000)

    console.log("[Zoom] HTML cleaner started")
  }

  public async stop(): Promise<void> {
    if (this.statusPoller) {
      clearInterval(this.statusPoller)
      this.statusPoller = undefined
    }
    await this.page
      .evaluate(() => {
        if (window.zoomHtmlCleanerInterval) {
          clearInterval(window.zoomHtmlCleanerInterval)
          delete window.zoomHtmlCleanerInterval
        }
      })
      .catch((e) => console.error("[Zoom] HTML cleaner stop error:", e))
    console.log("[Zoom] HTML cleaner stopped")
  }
}
