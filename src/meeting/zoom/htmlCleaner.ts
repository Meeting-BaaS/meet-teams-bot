import type { Page } from "@playwright/test"
import type { RecordingMode } from "../../types"

declare global {
  interface Window {
    zoomHtmlCleanerInterval?: NodeJS.Timeout
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
    await this.page.evaluate(() => {
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
      const clean = () => {
        for (const sel of HIDE_SELECTORS) {
          document.querySelectorAll(sel).forEach((el) => {
            ;(el as HTMLElement).style.opacity = "0"
          })
        }
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
