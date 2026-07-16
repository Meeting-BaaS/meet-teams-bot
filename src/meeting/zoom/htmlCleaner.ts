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
          "#video-share-layout video-player {",
          "  position: fixed !important; inset: 0 !important;",
          "  top: 0 !important; left: 0 !important;",
          "  width: 100vw !important; height: 100vh !important;",
          "  z-index: 2147483000 !important;",
          "}",
          "#video-share-layout video-player video {",
          "  width: 100% !important; height: 100% !important;",
          "  object-fit: cover !important;",
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

      // Screen-share sizing. MEDIA CHANGE forensics showed the VIEWED share is a
      // <video> Zoom mounts inside a container classed `sharee-container__canvas`,
      // which sits OUTSIDE #video-share-layout — so the speaker-view pin never
      // reaches it and it's laid out small/offset → tiny share, black everywhere.
      // That container holds a <video> ONLY while a share is being viewed, so its
      // presence is a clean, self-reverting on/off signal. When active, pin the
      // container to the whole frame and fit the video with object-fit: contain.
      // Speaker view is untouched.

      // Diagnostic (kept, capped): media layout on change, incl. position.
      let lastMediaSig = ""
      let mediaLogCount = 0
      const dumpMediaOnChange = () => {
        if (mediaLogCount >= 12) return
        const els = Array.from(document.querySelectorAll("canvas, video")).filter((e) => {
          const r = (e as HTMLElement).getBoundingClientRect()
          return r.width > 40 && r.height > 40
        })
        const sig = els
          .map((e) => {
            const r = (e as HTMLElement).getBoundingClientRect()
            return `${e.tagName}:${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`
          })
          .join("|")
        if (sig === lastMediaSig) return
        lastMediaSig = sig
        mediaLogCount++
        const detail = els.map((e) => {
          const el = e as HTMLElement
          const r = el.getBoundingClientRect()
          const chain: string[] = []
          let n: HTMLElement | null = el
          for (let i = 0; i < 5 && n; i++) {
            chain.push(`${n.tagName.toLowerCase()}#${n.id || "-"}.${String(n.className).slice(0, 45)}`)
            n = n.parentElement
          }
          return `${el.tagName} css=${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)} chain=${JSON.stringify(chain)}`
        })
        clog(`[Zoom] MEDIA CHANGE: ${JSON.stringify(detail)}`)
      }

      // Screen-share fix. MEDIA CHANGE forensics show Zoom lays the shared <video>
      // at full 1280x720 but OFFSET (e.g. @200,113) inside .sharee-container__canvas
      // — so ~200px off the right and ~113px off the bottom fall outside the
      // 1280x720 recorded frame (cropped) with black on the left/top. Pin ONLY that
      // <video> to the frame origin. Do NOT touch its wrappers or the scratch canvas
      // (that pushed things off-screen and blacked the whole recording last time).
      // Present only while viewing a share, so this reverts cleanly on stop.
      const SHARE_PIN_STYLE_ID = "baas-zoom-share-pin"
      let sharePinLogged = false
      const handleSharePin = () => {
        dumpMediaOnChange()
        const active = !!document.querySelector('[class*="sharee-container__canvas"] video')
        const existing = document.getElementById(SHARE_PIN_STYLE_ID)
        if (active && !existing) {
          const st = document.createElement("style")
          st.id = SHARE_PIN_STYLE_ID
          st.textContent = [
            '[class*="sharee-container__canvas"] video {',
            "  position: fixed !important; left: 0 !important; top: 0 !important; inset: 0 !important;",
            "  width: 100vw !important; height: 100vh !important;",
            "  object-fit: contain !important; object-position: center !important;",
            "  z-index: 2147483020 !important; background: #000 !important;",
            "}"
          ].join("\n")
          document.head.appendChild(st)
          if (!sharePinLogged) {
            sharePinLogged = true
            clog("[Zoom] Share video pinned to frame origin")
          }
        } else if (!active && existing) {
          existing.remove()
        }
      }

      const clean = () => {
        for (const sel of HIDE_SELECTORS) {
          document.querySelectorAll(sel).forEach((el) => {
            ; (el as HTMLElement).style.opacity = "0"
          })
        }
        handleSharePin()
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
