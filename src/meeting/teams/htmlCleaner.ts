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

      // Persistent stylesheet that hides Teams' calling notifications, permission
      // banners and toasts *declaratively* with !important. The imperative
      // el.style.display = "none" approach below is unreliable for these: Teams
      // keeps the toast node mounted and flips its visibility via class/style on
      // re-render (React), and the cleanup MutationObserver only watches
      // childList — so an attribute-only toggle is never re-cleaned and the
      // banner reappears and stays. A stylesheet applies to current AND future
      // matching nodes the instant they render and can't be undone by a
      // re-render (unless Teams sets inline !important, which it doesn't here).
      // Covers the "Teams needs permission to access your camera" banner and the
      // "<name> joined" toast that were being captured in the recording.
      const CLEANUP_STYLE_ID = "mbaas-teams-cleanup-style"
      function injectCleanupStylesheet(documentRoot: Document) {
        if (documentRoot.getElementById(CLEANUP_STYLE_ID)) return
        const style = documentRoot.createElement("style")
        style.id = CLEANUP_STYLE_ID
        // Notification / alert / toast families only — never the toolbar (the
        // bot clicks its "Leave" button to end the call, so it must stay in the
        // layout) and never the video stage.
        style.textContent = `
          [data-tid^="ufd_"],
          [data-tid^="callingAlert"],
          [data-tid$="-alert-container"],
          [data-severity],
          [role="alert"],
          .fui-Toast,
          .fui-Toaster { display: none !important; }
        `
        const head = documentRoot.head || documentRoot.documentElement
        if (head) {
          head.appendChild(style)
          console.log("[Teams] Cleanup stylesheet injected")
        }
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
          stage.style.zIndex = "2147483000"
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

      // DIAGNOSTIC: dump the live meeting DOM so we can target the exact v2 selectors
      // for the chat rail, the video stage, and the camera/mic controls. Logged once
      // at cleaner start; remove once the modern selectors are pinned down.
      function logCleanerDiag(documentRoot: Document) {
        try {
          const win = documentRoot.defaultView || window
          const lines: string[] = [`[Teams][cleaner-diag] url=${location.href}`]
          const videos = Array.from(documentRoot.querySelectorAll("video"))
          lines.push(`videos=${videos.length}`)
          videos.slice(0, 4).forEach((v, i) => {
            const chain: string[] = []
            let n: Element | null = v
            for (let d = 0; d < 10 && n; d++) {
              const tid = n.getAttribute("data-tid")
              chain.push(`${n.tagName}${n.id ? `#${n.id}` : ""}${tid ? `[${tid}]` : ""}`)
              n = n.parentElement
            }
            const r = v.getBoundingClientRect()
            lines.push(
              `  video#${i} ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.left)},${Math.round(r.top)} chain=${chain.join(" < ")}`,
            )
          })
          const big: Array<{ tid: string; w: number; h: number; x: number; z: string }> = []
          documentRoot.querySelectorAll("[data-tid]").forEach((el) => {
            if (!(el instanceof HTMLElement)) return
            const r = el.getBoundingClientRect()
            if (r.width < 150 || r.height < 150) return
            big.push({
              tid: el.getAttribute("data-tid") || "",
              w: Math.round(r.width),
              h: Math.round(r.height),
              x: Math.round(r.left),
              z: win.getComputedStyle(el).zIndex,
            })
          })
          big.sort((a, b) => b.w * b.h - a.w * a.h)
          lines.push("large-containers (rails/stage):")
          big.slice(0, 18).forEach((b) => lines.push(`  tid=${b.tid} ${b.w}x${b.h} @x${b.x} z=${b.z}`))
          const btns: string[] = []
          documentRoot.querySelectorAll('button, [role="button"]').forEach((el) => {
            if (!(el instanceof HTMLElement)) return
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) return
            const label = (
              el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.textContent ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 40)
            const tid = el.getAttribute("data-tid")
            if (label || tid) btns.push(`${tid ? `[${tid}]` : ""} ${label}`.trim())
          })
          lines.push(`buttons(${btns.length}): ${JSON.stringify(btns.slice(0, 40))}`)
          console.log(lines.join("\n"))
        } catch (e) {
          console.warn("[Teams][cleaner-diag] failed", e)
        }
      }

      // The AUTHENTICATED teams.microsoft.com/v2 client differs from BOTH the classic
      // client and the teams.live.com "light" client. Its chat / people rail renders at
      // a very high z-index, so cleanLightClient's stage promotion doesn't cover it and
      // the chat panel (kept open for compose + network capture) shows in the recording.
      // Here we (a) hide the right rail / chat / roster panels and (b) promote the
      // meeting video stage above everything — falling back to the common ancestor of
      // the <video> tiles when no known stage tid matches. No-op on other clients.
      function cleanModernClient(documentRoot: Document) {
        let hidden = 0
        const railSelectors = [
          '[data-tid="chat-pane-list"]',
          '[data-tid="chat-pane-compose-message-footer"]',
          '[data-tid="right-rail"]',
          '[data-tid="calling-right-side-panel"]',
          '[data-tid="roster-panel"]',
          '[data-tid="people-panel"]',
          '[role="complementary"]',
        ]
        for (const sel of railSelectors) {
          documentRoot.querySelectorAll(sel).forEach((el) => {
            if (!(el instanceof HTMLElement)) return
            el.style.display = "none"
            hidden++
            // Collapse the immediate rail wrapper too, but never a layout root.
            const parent = el.parentElement
            if (
              parent instanceof HTMLElement &&
              parent.id !== "call-screen-wrapper" &&
              parent.id !== "root" &&
              parent.tagName !== "BODY"
            ) {
              parent.style.display = "none"
            }
          })
        }

        // Promote the meeting stage to fullscreen, above the chat rail. Prefer known
        // modern stage tids; fall back to the smallest common ancestor of the video
        // tiles so this keeps working even if Teams renames the stage container.
        let stage: Element | null =
          documentRoot.querySelector('[data-tid="calling-stage"]') ||
          documentRoot.querySelector('[data-tid="modern-stage"]') ||
          documentRoot.querySelector('[data-tid="stage-layout"]') ||
          documentRoot.querySelector('[data-tid="modern-stage-wrapper"]') ||
          documentRoot.querySelector('[data-tid="only-videos-wrapper"]')
        if (!(stage instanceof HTMLElement)) {
          const videos = Array.from(documentRoot.querySelectorAll("video"))
          if (videos.length > 0) {
            let common: HTMLElement | null = videos[0].parentElement
            while (common && !videos.every((v) => (common as HTMLElement).contains(v))) {
              common = common.parentElement
            }
            stage = common
          }
        }
        if (stage instanceof HTMLElement) {
          stage.style.position = "fixed"
          stage.style.top = "0"
          stage.style.left = "0"
          stage.style.width = "100vw"
          stage.style.height = "100vh"
          stage.style.zIndex = "2147483000"
          stage.style.backgroundColor = "black"
        }

        if (hidden > 0) {
          console.log(
            "[Teams] modern: hid",
            hidden,
            "rail element(s); stage promoted:",
            stage instanceof HTMLElement,
          )
        }
      }

      async function removeInitialShityHtml() {
        console.log("[Teams] Starting removeInitialShityHtml")
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const documentRoot = getDocumentRoot()
        injectCleanupStylesheet(documentRoot)
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
        cleanModernClient(documentRoot)
      }

      function removeShityHtml() {
        console.log("[Teams] Starting removeShityHtml")
        const documentRoot = getDocumentRoot()
        injectCleanupStylesheet(documentRoot)
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
        cleanModernClient(documentRoot)
      }

      // Execute Teams provider
      console.log("[Teams] Executing HTML provider")
      await removeInitialShityHtml()

      // Batched cleanup: defer to next event loop tick so multiple DOM mutations
      // within the same synchronous batch trigger only one removeShityHtml() call.
      // Teams constantly adds/removes nodes (banners, menus, chat panels), and
      // without batching the observer fires 1300+ times per session.
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
