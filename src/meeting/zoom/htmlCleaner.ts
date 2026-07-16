import type { Page } from "@playwright/test"
import type { RecordingMode } from "../../types"

declare global {
  interface Window {
    zoomHtmlCleanerInterval?: NodeJS.Timeout
    zoomCleanerLog?: (msg: string) => void
  }
}

/**
 * Zoom Web recording cleaner — hides the browser-client chrome (footer toolbar,
 * header, reaction/notification toasts, "you are viewing" banners) so the
 * ffmpeg x11grab capture shows the video tiles / active speaker, not Zoom's UI.
 *
 * First-cut selectors from the live Zoom Web DOM; runs on an interval like
 * MeetHtmlCleaner because Zoom mounts toasts and banners dynamically. Anchors
 * on stable class prefixes and leaves the video surface untouched.
 */
export class ZoomHtmlCleaner {
  private page: Page
  private recordingMode: RecordingMode

  constructor(page: Page, recordingMode: RecordingMode) {
    this.page = page
    this.recordingMode = recordingMode
  }

  public async start(): Promise<void> {
    console.log("[Zoom] Starting HTML cleaner")
    // Bridge in-page cleaner diagnostics to the bot log. In-page console.log is
    // dropped unless LOG_LEVEL=debug (that's why the share diagnostics never
    // showed up), so route through an exposed function like the speaker observer.
    await this.page
      .exposeFunction("zoomCleanerLog", (msg: string) => console.log(msg))
      .catch(() => {})
    await this.page.evaluate(() => {
      const clog = (m: string) => {
        try {
          window.zoomCleanerLog?.(m)
        } catch {
          /* bridge unavailable */
        }
      }
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
      // Hide with opacity ONLY — never `pointer-events: none`, and never
      // display:none. The Leave button lives inside `.footer`, and closeMeeting
      // clicks it to end the call: pointer-events:none makes Playwright's
      // hit-target check fail, so every normal meeting end hangs until timeout
      // and the bot never actually leaves. (Meet hit this exact trap — see the
      // evaluate-click comment in meet.ts.) Elements must stay in the layout and
      // stay clickable; they just must not be visible in the recording.
      // Inject CSS (once) that (a) forces the Zoom speaker video to fill the whole
      // recorded frame — killing the black band, and covering the participants
      // panel when we open it to read the roster — and (b) hides the name/network
      // label overlaid on the tile. Uses opacity:0 for the name so the speaker
      // observer can still read its text (display:none would keep it readable too,
      // but opacity is safe and consistent with the rest of the cleaner).
      const STYLE_ID = "baas-zoom-rec-fix"
      if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement("style")
        style.id = STYLE_ID
        style.textContent = [
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
          // ── Speaker-bar strip — hidden from the recording in BOTH modes ────
          // The horizontal strip of participant tiles (speaker-bar-container__*,
          // the "Recording Bot"/other-camera tiles) is clutter over the main
          // content. opacity:0 keeps it in the DOM so the speaker observer can
          // still read .speaker-bar-container__video-frame--active.
          '[class*="speaker-bar-container"] { opacity: 0 !important; }',
          // ── Share view — pin the shared screen to fill the frame ──────────
          // Gated on `html.baas-share-active` (toggled from JS only while a share is
          // ACTUALLY rendering) so the empty #sharee-container Zoom mounts at 0x0 can
          // never blow up into a full-frame black overlay over the speaker view.
          //
          // The share renders in #sharee-container > .sharee-container__viewport,
          // and that viewport is a react-draggable (CSS transform). A position:fixed
          // pin on anything INSIDE it anchors to the transform → offset & cropped. So
          // pin the container itself (not transformed), neutralise the transform, and
          // let Zoom size the canvas to the content aspect (capped + centred =
          // contain, no crop). z-index above the speaker pin.
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
          ".video-avatar__avatar-footer { opacity: 0 !important; }",
          // The speaker observer opens the participants pane to read the roster
          // (so the log can show Speaker 1/2/3). Force that pane OFF-SCREEN and out
          // of flow so it never appears in the recording and never squeezes the
          // video — but keep it sized/rendered so its names stay readable in the DOM.
          "#wc-container-right {",
          "  position: fixed !important; left: -100000px !important; top: 0 !important;",
          "  width: 360px !important; height: 100vh !important;",
          "  opacity: 0 !important; pointer-events: none !important; z-index: -1 !important;",
          "}"
        ].join("\n")
        document.head.appendChild(style)
      }

      // Share detection → toggles `html.baas-share-active`, which the share-pin CSS
      // above is scoped to. Keyed on the ACTUAL rendered canvas size (not merely the
      // presence of #sharee-container, which Zoom also mounts empty at 0x0), so the
      // full-frame black pin can only ever apply while a real share is on screen.
      let shareActive = false
      const updateShareState = () => {
        const canvas = document.querySelector(".sharee-container__canvas") as HTMLElement | null
        const r = canvas?.getBoundingClientRect()
        const active = !!r && r.width > 200 && r.height > 150
        if (active !== shareActive) {
          shareActive = active
          document.documentElement.classList.toggle("baas-share-active", active)
          clog(active ? "[Zoom] Screen share detected — pinned to frame" : "[Zoom] Screen share ended")
        }
      }

      const clean = () => {
        for (const sel of HIDE_SELECTORS) {
          document.querySelectorAll(sel).forEach((el) => {
            ; (el as HTMLElement).style.opacity = "0"
          })
        }
        updateShareState()
      }
      clean()
      window.zoomHtmlCleanerInterval = setInterval(clean, 500)
    })
    console.log("[Zoom] HTML cleaner started")
  }

  public async stop(): Promise<void> {
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
