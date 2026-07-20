import type { Page } from "@playwright/test"

/**
 * DIAGNOSTIC SPIKE — gated by ZOOM_WS_SPIKE (default off). Pure observation, no
 * behavior change. Logs Zoom's WebSocket signaling so we can decide whether
 * network-based active-speaker detection is viable vs the DOM observer, by
 * answering two questions from real traffic:
 *   1. Is the active-speaker socket in the MAIN thread or a Web Worker?
 *      (Zoom offloads its RWG connection to a worker on some layouts — if so, a
 *      main-thread WebSocket hook can't see it.)
 *   2. Are the frames READABLE (JSON / protobuf-ish text) or opaque/binary?
 * Everything goes to console -> bot log -> S3, prefixed [WS-SPIKE].
 */

// Injected verbatim via page.addInitScript, so it must be FULLY self-contained
// (no imports, no outer refs). It self-replicates into Web Workers by prepending
// its own source to the worker script (Blob URL) before importScripts-ing the
// original — a WORKER-INJECT-FAILED log then tells us if CSP blocks that path.
function zoomWsSpikeBrowser() {
  const TAG = "[WS-SPIKE]"
  const MAX_FRAMES = 12

  const sample = (d: unknown): string => {
    try {
      if (typeof d === "string") return "str(" + d.length + ") " + d.slice(0, 300)
      if (d instanceof ArrayBuffer) {
        const u = new Uint8Array(d)
        const hex = Array.from(u.slice(0, 48))
          .map((x) => x.toString(16).padStart(2, "0"))
          .join(" ")
        return "buf(" + d.byteLength + ") " + hex
      }
      if (typeof Blob !== "undefined" && d instanceof Blob) return "blob(" + d.size + ")"
      return "other " + String(d).slice(0, 120)
    } catch {
      return "??"
    }
  }

  const wrapWS = (scope: { WebSocket?: unknown }, where: string): void => {
    // biome-ignore lint/suspicious/noExplicitAny: browser-global juggling
    const s = scope as any
    const Orig = s.WebSocket
    if (!Orig || Orig.__wsSpiked) return
    // biome-ignore lint/suspicious/noExplicitAny: dynamic ctor wrap
    const Wrapped: any = function (url: string, protos?: unknown) {
      try {
        console.log(TAG, where, "OPEN", url)
      } catch {}
      const ws = protos !== undefined ? new Orig(url, protos) : new Orig(url)
      let n = 0
      try {
        ws.addEventListener("message", (ev: { data: unknown }) => {
          if (n < MAX_FRAMES) {
            n++
            try {
              console.log(TAG, where, "MSG", url, sample(ev.data))
            } catch {}
          }
        })
      } catch {}
      return ws
    }
    try {
      Wrapped.prototype = Orig.prototype
      Wrapped.CONNECTING = Orig.CONNECTING
      Wrapped.OPEN = Orig.OPEN
      Wrapped.CLOSING = Orig.CLOSING
      Wrapped.CLOSED = Orig.CLOSED
      Wrapped.__wsSpiked = true
      s.WebSocket = Wrapped
    } catch (e) {
      try {
        console.log(TAG, where, "WRAP-WS-FAILED", String(e))
      } catch {}
    }
  }

  // 1) main scope (or the current worker scope, when re-run inside a worker)
  wrapWS(self as unknown as { WebSocket?: unknown }, "main")

  // 2) self-replicate into Web Workers
  try {
    // biome-ignore lint/suspicious/noExplicitAny: browser-global juggling
    const w = self as any
    const OrigWorker = w.Worker
    if (OrigWorker && !OrigWorker.__wsSpiked) {
      const src = "(" + zoomWsSpikeBrowser.toString() + ")();"
      // biome-ignore lint/suspicious/noExplicitAny: dynamic ctor wrap
      const WrappedWorker: any = function (url: string | URL, opts?: unknown) {
        try {
          console.log(TAG, "main", "WORKER-CREATE", String(url))
        } catch {}
        try {
          const base = w.location ? w.location.href : undefined
          const abs = new URL(String(url), base).href
          const boot =
            src +
            "\ntry{importScripts(" +
            JSON.stringify(abs) +
            ");}catch(e){console.log('" +
            TAG +
            "','worker','IMPORT-FAIL',String(e));}"
          const blobUrl = URL.createObjectURL(new Blob([boot], { type: "application/javascript" }))
          return new OrigWorker(blobUrl, opts)
        } catch (e) {
          try {
            console.log(TAG, "main", "WORKER-INJECT-FAILED (CSP?)", String(e))
          } catch {}
          return new OrigWorker(url, opts)
        }
      }
      WrappedWorker.prototype = OrigWorker.prototype
      WrappedWorker.__wsSpiked = true
      w.Worker = WrappedWorker
    }
  } catch (e) {
    try {
      console.log(TAG, "main", "WRAP-WORKER-FAILED", String(e))
    } catch {}
  }
}

/** Inject the diagnostic logger. Call BEFORE page.goto(), guarded by the flag. */
export async function injectZoomWsSpike(page: Page): Promise<void> {
  await page.addInitScript(zoomWsSpikeBrowser)
  console.log("[WS-SPIKE] injected Zoom WebSocket/Worker logger (diagnostic, ZOOM_WS_SPIKE=on)")
}
