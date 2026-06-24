import type { Page } from "@playwright/test"
import { HtmlSnapshotService } from "../../services/html-snapshot-service"
import type { RecordingMode } from "../../types"

export class TeamsHtmlCleaner {
  private page: Page

  constructor(page: Page, _recordingMode: RecordingMode) {
    this.page = page
  }

  public async start(): Promise<void> {
    console.log("[Teams] Starting HTML cleaner")

    // Capture DOM state before starting Teams HTML cleaning
    const htmlSnapshot = HtmlSnapshotService.getInstance()
    await htmlSnapshot.captureSnapshot(this.page, "teams_html_cleaner_before_cleaning")

    // Wait 1 second like in original extension
    await this.page.waitForTimeout(1000)

    // Inject Teams provider logic into browser context
    await this.page.evaluate(async () => {
      // EXACT TEAMS PROVIDER FUNCTIONS FROM ORIGINAL EXTENSION
      function getDocumentRoot(): Document {
        for (const iframe of document.querySelectorAll("iframe")) {
          try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document
            if (doc) {
              console.log("[Teams] Document root found in iframe")
              return doc
            }
          } catch (e) {
            console.warn("[Teams] Error accessing iframe content", e)
          }
        }
        console.log("[Teams] Using main document as root")
        return document
      }

      // Teams "light" web client (teams.live.com) uses a different DOM than
      // the classic client targeted above: there is no app-layout-area--header,
      // the video tiles are not 137x245, and the chat/controls live under
      // different data-tids. Hide that chrome and promote the video stage to
      // fullscreen so the recording shows only the speaker(s).
      // No-op on the classic client (selectors just miss).
      function cleanLightClient(documentRoot: Document) {
        const hideTids = [
          "calling-right-side-panel", // chat / people side rail
          "simplified-compose-bottom-toolbar", // chat compose bar
          "rail-header",
          "message-pane-footer",
          "chat-pane-compose-message-footer",
        ]
        let hiddenLight = 0
        for (const tid of hideTids) {
          documentRoot.querySelectorAll(`[data-tid="${tid}"]`).forEach((el) => {
            if (el instanceof HTMLElement) {
              el.style.display = "none"
              hiddenLight++
            }
          })
        }

        // Notification / permission banners (data-tid^="ufd_" / "callingAlert")
        // e.g. "Teams needs permission to access your camera". Bots have no
        // camera/mic device, so these always appear and, being overlays
        // (vdi-occlusion), sit on top of even the fullscreen stage.
        documentRoot
          .querySelectorAll('[data-tid^="ufd_"], [data-tid^="callingAlert"]')
          .forEach((el) => {
            if (el instanceof HTMLElement) {
              el.style.display = "none"
              hiddenLight++
            }
          })

        // Toolbars: both the bottom call-controls bar (mic / camera / leave /
        // More, containing callingButtons-*) AND the top call-header bar
        // (meeting title, encryption status, and the call-duration timer) are
        // role="toolbar". Hide them all for a clean speaker-only recording.
        const stageSel =
          '[data-tid="stage-layout"], [data-tid="modern-stage-wrapper"], [data-tid="only-videos-wrapper"]'
        documentRoot.querySelectorAll('[role="toolbar"]').forEach((el) => {
          if (!(el instanceof HTMLElement)) return
          el.style.display = "none"
          hiddenLight++
          // The toolbar usually sits in a thin "bar" wrapper that keeps a blank
          // white strip even once the toolbar inside is hidden. Collapse that
          // wrapper too — but never a top-level layout node or one that
          // contains the video stage.
          const parent = el.parentElement
          if (
            parent instanceof HTMLElement &&
            parent.id !== "call-screen-wrapper" &&
            parent.id !== "root" &&
            parent.tagName !== "BODY" &&
            !parent.querySelector(stageSel)
          ) {
            parent.style.display = "none"
          }
        })

        // Promote the video stage to fullscreen so it covers any remaining
        // chrome. Prefer the outer stage container, fall back to the
        // videos / shared-content wrappers.
        const stage =
          documentRoot.querySelector('[data-tid="stage-layout"]') ||
          documentRoot.querySelector('[data-tid="modern-stage-wrapper"]') ||
          documentRoot.querySelector('[data-tid="only-videos-wrapper"]')
        if (stage instanceof HTMLElement) {
          stage.style.position = "fixed"
          stage.style.top = "0"
          stage.style.left = "0"
          stage.style.width = "100vw"
          stage.style.height = "100vh"
          stage.style.zIndex = "9998"
          stage.style.backgroundColor = "black"
        }

        if (hiddenLight > 0) {
          console.log(
            "[Teams] light: hid",
            hiddenLight,
            "chrome element(s); stage promoted:",
            stage instanceof HTMLElement,
          )
        }
      }

      async function removeInitialShityHtml() {
        console.log("[Teams] Starting removeInitialShityHtml")
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const documentRoot = getDocumentRoot()
        try {
          const meetingControls = documentRoot.querySelectorAll(
            `div[data-tid="app-layout-area--header"]`,
          )
          if (meetingControls[0] instanceof HTMLElement) {
            meetingControls[0].style.opacity = "0"
            console.log("[Teams] Meeting controls hidden")
          }
        } catch (e) {
          console.error("[Teams] Failed to remove buttons header", e)
        }

        try {
          const style = documentRoot.createElement("style")
          documentRoot.head.appendChild(style)
          const sheet = style.sheet
          sheet?.insertRule(
            `
                        [data-tid="voice-level-stream-outline"]::before {
                          border: 0px solid rgb(127, 133, 245);
                        }
                      `,
            sheet.cssRules.length,
          )
          console.log("[Teams] Voice level stream outline style added")
        } catch (e) {
          console.error("[Teams] Error in insert before style", e)
        }

        try {
          const mainArea = documentRoot.querySelector('div[data-tid="app-layout-area--main"]')
          if (mainArea instanceof HTMLElement) {
            mainArea.style.height = "100vh"
            mainArea.style.width = "100vw"
          }
        } catch (e) {
          console.error("[Teams] Failed to modify main area", e)
        }

        cleanLightClient(documentRoot)
      }

      function removeShityHtml() {
        console.log("[Teams] Starting removeShityHtml")
        const documentRoot = getDocumentRoot()
        try {
          const menus = documentRoot.querySelectorAll('[role="menu"]')
          const menu = menus[0] || menus
          if (menu instanceof HTMLElement) {
            menu.style.position = "fixed"
            menu.style.top = "0"
            menu.style.left = "0"
            menu.style.width = "100vw"
            menu.style.height = "100vh"
            menu.style.zIndex = "9999"
            menu.style.backgroundColor = "black"
            console.log("[Teams] Menu element hidden")
          }
        } catch (e) {
          console.error("[Teams] Error in remove shitty html", e)
        }

        try {
          let hiddenDivs = 0
          documentRoot.querySelectorAll("div").forEach((div) => {
            if (
              (div as HTMLElement).clientHeight === 137 &&
              (div as HTMLElement).clientWidth === 245
            ) {
              ;(div as HTMLElement).style.opacity = "0"
              hiddenDivs++
            }
          })
          console.log("[Teams] Hidden", hiddenDivs, "additional elements")
        } catch (e) {
          console.error("[Teams] Error in remove additional elements", e)
        }

        try {
          const mainArea = documentRoot.querySelector('div[data-tid="app-layout-area--main"]')
          if (mainArea instanceof HTMLElement) {
            mainArea.style.height = "100vh"
            mainArea.style.width = "100vw"
          }
        } catch (e) {
          console.error("[Teams] Failed to modify main area", e)
        }

        cleanLightClient(documentRoot)
      }

      // Execute Teams provider
      console.log("[Teams] Executing HTML provider")
      await removeInitialShityHtml()

      // Batched cleanup: defer to next event loop tick so multiple DOM mutations
      // within the same synchronous batch trigger only one removeShityHtml() call.
      // Without this the observer fires 1300+ times per session due to its own
      // DOM mutations creating a feedback loop.
      let cleanupScheduled = false
      const observer = new MutationObserver(() => {
        if (cleanupScheduled) return
        cleanupScheduled = true
        ;(window as any).htmlCleanerCleanupTimeout = setTimeout(() => {
          ;(window as any).htmlCleanerCleanupTimeout = null
          cleanupScheduled = false
          removeShityHtml()
        }, 0)
      })

      if (document.documentElement) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        })
      }

      ;(window as any).htmlCleanerObserver = observer
      console.log("[Teams] HTML provider complete")
    })
  }

  public async stop(): Promise<void> {
    console.log("[Teams] Stopping HTML cleaner")

    await this.page
      .evaluate(() => {
        if ((window as any).htmlCleanerCleanupTimeout) {
          clearTimeout((window as any).htmlCleanerCleanupTimeout)
          delete (window as any).htmlCleanerCleanupTimeout
        }
        if ((window as any).htmlCleanerObserver) {
          ;(window as any).htmlCleanerObserver.disconnect()
          delete (window as any).htmlCleanerObserver
        }
      })
      .catch((e) => console.error("[Teams] HTML cleaner stop error:", e))

    console.log("[Teams] HTML cleaner stopped")
  }
}
