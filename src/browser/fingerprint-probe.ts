import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Page } from "@playwright/test"
import { envVars } from "../config/env-vars"
import { formatError } from "../utils/Logger"
import { PathManager } from "../utils/PathManager"

/**
 * One-shot fingerprint dump: measures what a detector's JS actually sees at the
 * moment of a block, instead of inferring it from browser.ts / the Dockerfile.
 *
 * CloakBrowser spoofs the platform to Windows via the native binary
 * (--fingerprint-platform=windows), but the container ships only a Debian-server
 * font set and renders WebGL through whatever GPU stack the pod has. Whether the
 * page ends up as a coherent "Windows desktop" or a "Linux box wearing a Windows
 * UA" is decidable only from the runtime values — so dump them:
 *
 *   - navigator (UA, platform, webdriver, languages, plugins, UA-CH) — the OS story
 *   - WebGL UNMASKED_VENDOR / UNMASKED_RENDERER — the SwiftShader / GPU tell
 *   - font enumeration (Windows-core vs Linux-only candidates) — the font-list tell
 *   - screen / dpr / viewport geometry — the spoofed-resolution coherence tell
 *   - CDP Runtime.enable leak self-test — the fingerprint-independent automation tell
 *
 * Two entry points share one page.evaluate:
 *   - probeFingerprint(): returns a compact summary for telemetry. Runs in prod
 *     (no debug gate, no file writes), so every Meet detection signal can carry
 *     the fingerprint the detector saw and we can correlate tells vs flag rate.
 *   - captureFingerprint(): the debug dump (full JSON + screenshot to the
 *     html-snapshots dir), gated on BROWSER_DEBUG_CAPTURE. Read-only diagnostic.
 */

// Windows core fonts a real Windows Chrome exposes. Absent in our container.
const WINDOWS_FONTS = [
  "Segoe UI",
  "Calibri",
  "Cambria",
  "Consolas",
  "Arial",
  "Times New Roman",
  "Tahoma",
  "Verdana",
  "Georgia",
  "Trebuchet MS",
  "Courier New",
  "Comic Sans MS",
  "Impact",
  "Lucida Console",
  "Bahnschrift",
  "Candara",
  "Corbel",
  "Franklin Gothic Medium",
  "Segoe UI Emoji",
  "MS Gothic"
]

// Fonts the Debian-server packages in our Dockerfile actually install. Their
// presence alongside absent Windows fonts is the "Linux under a Windows UA" tell.
const LINUX_FONTS = [
  "DejaVu Sans",
  "Liberation Sans",
  "Liberation Serif",
  "Liberation Mono",
  "FreeSans",
  "FreeSerif",
  "Noto Color Emoji",
  "WenQuanYi Zen Hei",
  "IPAGothic",
  "Ubuntu"
]

/** Raw fingerprint object returned by the in-page evaluate. */
type RawFingerprint = {
  navigator: {
    userAgent: unknown
    platform: unknown
    webdriver: unknown
    [k: string]: unknown
  }
  cdp: { runtimeEnableLeak: boolean | null }
  webgl: { renderer?: unknown; unmaskedRenderer?: unknown } | null
  webgl2: { renderer?: unknown; unmaskedRenderer?: unknown } | null
  fonts: {
    windowsProbed: number
    windowsPresent: string[]
    linuxProbed: number
    linuxPresent: string[]
    documentFontsSize: number | null
  }
  geometry: {
    dpr: number
    screen: string
    inner: string
    [k: string]: unknown
  }
}

/**
 * Compact, high-signal slice of the fingerprint, sized for telemetry: it rides
 * in every Meet detection signal's run_context so each attribute can be
 * correlated against detected_as_bot. Keep it small — one row per bot join.
 */
export type FingerprintSummary = {
  verdict: "CDP-RUNTIME-LEAK" | "MIXED-OS-TELL" | "ok"
  cdp_runtime_leak: boolean | null
  claims_windows: boolean
  platform: string | null
  webdriver: boolean | null
  win_fonts_present: number
  lin_fonts_present: number
  webgl_renderer: string | null
  dpr: number | null
  screen: string | null
  inner: string | null
}

/** Run the in-page fingerprint evaluate. Never throws; null on any failure. */
async function evaluateFingerprint(page: Page): Promise<RawFingerprint | null> {
  if (page.isClosed()) return null
  try {
    return (await page.evaluate(
      ({ winFonts, linFonts }) => {
        const nav = navigator as Navigator & {
          userAgentData?: {
            brands?: { brand: string; version: string }[]
            platform?: string
            mobile?: boolean
            getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>>
          }
          deviceMemory?: number
        }

        // --- navigator / OS story ---
        const navigatorInfo: Record<string, unknown> = {
          userAgent: nav.userAgent,
          platform: nav.platform,
          vendor: nav.vendor,
          language: nav.language,
          languages: nav.languages,
          webdriver: nav.webdriver,
          hardwareConcurrency: nav.hardwareConcurrency,
          deviceMemory: nav.deviceMemory ?? null,
          maxTouchPoints: nav.maxTouchPoints,
          plugins: Array.from(nav.plugins ?? []).map((p) => p.name),
          mimeTypesCount: nav.mimeTypes?.length ?? 0,
          uaData: nav.userAgentData
            ? {
                brands: nav.userAgentData.brands,
                platform: nav.userAgentData.platform,
                mobile: nav.userAgentData.mobile
              }
            : null
        }

        // --- WebGL vendor / renderer (both plain + UNMASKED) ---
        const readGl = (type: "webgl" | "webgl2") => {
          try {
            const c = document.createElement("canvas")
            const gl = c.getContext(type) as WebGLRenderingContext | null
            if (!gl) return null
            const dbg = gl.getExtension("WEBGL_debug_renderer_info")
            return {
              vendor: gl.getParameter(gl.VENDOR),
              renderer: gl.getParameter(gl.RENDERER),
              unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
              unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
              version: gl.getParameter(gl.VERSION),
              shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION)
            }
          } catch {
            return null
          }
        }

        // --- font enumeration (canvas width/height measurement) ---
        // A candidate is "present" if rendering a probe string in it changes the
        // metrics away from all three generic base families. This is the same
        // technique FingerprintJS/CreepJS use to build the font-list axis.
        const detectFonts = (candidates: string[]) => {
          const baseFonts = ["monospace", "sans-serif", "serif"]
          const probe = "mmmmmmmmmmlli WwQq 0123456789"
          const size = "72px"
          const canvas = document.createElement("canvas")
          const ctx = canvas.getContext("2d")
          if (!ctx) return { present: candidates, note: "no-2d-context" }

          const baseline: Record<string, { w: number; h: number }> = {}
          for (const base of baseFonts) {
            ctx.font = `${size} ${base}`
            const m = ctx.measureText(probe)
            baseline[base] = {
              w: m.width,
              h: (m.actualBoundingBoxAscent ?? 0) + (m.actualBoundingBoxDescent ?? 0)
            }
          }

          const present: string[] = []
          for (const font of candidates) {
            let detected = false
            for (const base of baseFonts) {
              ctx.font = `${size} "${font}", ${base}`
              const m = ctx.measureText(probe)
              const h = (m.actualBoundingBoxAscent ?? 0) + (m.actualBoundingBoxDescent ?? 0)
              if (
                Math.abs(m.width - baseline[base].w) > 0.5 ||
                Math.abs(h - baseline[base].h) > 0.5
              ) {
                detected = true
                break
              }
            }
            if (detected) present.push(font)
          }
          return { present }
        }

        // --- CDP Runtime.enable leak self-test ---
        // The dominant modern bot tell, and fingerprint-INDEPENDENT: if the
        // automation layer has sent Runtime.enable (vanilla Playwright/Puppeteer
        // do it on every frame), Chromium serialises console arguments for the
        // Runtime.consoleAPICalled event, building an object preview that invokes
        // property getters. A real user browser with no CDP client attached never
        // does this. So a getter that fires during console.debug == CDP leaking.
        // If this reads true, no amount of UA/WebGL/font spoofing will hide the bot.
        let runtimeEnableLeak: boolean | null = null
        try {
          let triggered = false
          const bait: Record<string, unknown> = {}
          Object.defineProperty(bait, "id", {
            get() {
              triggered = true
              return 1
            },
            enumerable: true
          })
          console.debug(bait)
          runtimeEnableLeak = triggered
        } catch {
          runtimeEnableLeak = null
        }

        return {
          navigator: navigatorInfo,
          cdp: { runtimeEnableLeak },
          webgl: readGl("webgl"),
          webgl2: readGl("webgl2"),
          fonts: {
            windowsProbed: winFonts.length,
            windowsPresent: detectFonts(winFonts).present,
            linuxProbed: linFonts.length,
            linuxPresent: detectFonts(linFonts).present,
            documentFontsSize:
              (document as unknown as { fonts?: { size?: number } }).fonts?.size ?? null
          },
          geometry: {
            dpr: window.devicePixelRatio,
            screen: `${screen.width}x${screen.height}`,
            avail: `${screen.availWidth}x${screen.availHeight}`,
            inner: `${window.innerWidth}x${window.innerHeight}`,
            outer: `${window.outerWidth}x${window.outerHeight}`,
            colorDepth: screen.colorDepth
          }
        }
      },
      { winFonts: WINDOWS_FONTS, linFonts: LINUX_FONTS }
    )) as unknown as RawFingerprint
  } catch {
    return null
  }
}

/** Reduce the raw fingerprint to the coherence verdict + telemetry summary. */
function summarizeFingerprint(fp: RawFingerprint): FingerprintSummary {
  // Coherence verdict: Windows UA/platform but Linux fonts present and no
  // Windows fonts = the mixed-OS tell. CDP leak is the most severe tell, so it
  // wins the verdict; then the font mix.
  const claimsWindows =
    /windows/i.test(String(fp.navigator.userAgent)) ||
    String(fp.navigator.platform).startsWith("Win")
  const winFontCount = fp.fonts.windowsPresent.length
  const linFontCount = fp.fonts.linuxPresent.length
  const verdict =
    fp.cdp.runtimeEnableLeak === true
      ? "CDP-RUNTIME-LEAK"
      : claimsWindows && winFontCount === 0 && linFontCount > 0
        ? "MIXED-OS-TELL"
        : "ok"

  const renderer = fp.webgl?.unmaskedRenderer ?? fp.webgl?.renderer ?? null
  return {
    verdict,
    cdp_runtime_leak: fp.cdp.runtimeEnableLeak,
    claims_windows: claimsWindows,
    platform: fp.navigator.platform == null ? null : String(fp.navigator.platform),
    webdriver: typeof fp.navigator.webdriver === "boolean" ? fp.navigator.webdriver : null,
    win_fonts_present: winFontCount,
    lin_fonts_present: linFontCount,
    webgl_renderer: renderer == null ? null : String(renderer),
    dpr: typeof fp.geometry.dpr === "number" ? fp.geometry.dpr : null,
    screen: fp.geometry.screen == null ? null : String(fp.geometry.screen),
    inner: fp.geometry.inner == null ? null : String(fp.geometry.inner)
  }
}

// The probe runs a page.evaluate, which has no per-call timeout and can hang if
// the renderer is wedged — precisely the state a flagged/blocked bot's page may
// be in. Since this gates the detection-signal report, bound it: on deadline we
// report fingerprint: null rather than losing the signal for that bot.
const PROBE_TIMEOUT_MS = 3000

/**
 * Prod telemetry entry: capture the fingerprint the detector saw and return a
 * compact summary for the detection signal's run_context. Never throws, writes
 * no files, and is NOT gated on BROWSER_DEBUG_CAPTURE — this is how we correlate
 * fingerprint tells against Meet's flag decision. Returns null if the page is
 * gone, the evaluate fails, or the probe exceeds PROBE_TIMEOUT_MS; callers must
 * treat null as "unknown".
 */
export async function probeFingerprint(page: Page): Promise<FingerprintSummary | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)
    // Don't let a pending probe keep the process alive on shutdown.
    timer.unref?.()
  })
  try {
    const fp = await Promise.race([evaluateFingerprint(page), deadline])
    return fp ? summarizeFingerprint(fp) : null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Debug dump: full fingerprint JSON + screenshot to the html-snapshots dir.
 * `label` distinguishes call sites in the filename (e.g. "zoom_prejoin").
 * Gated on BROWSER_DEBUG_CAPTURE, off by default. Never throws.
 */
export async function captureFingerprint(page: Page, label: string): Promise<void> {
  if (!envVars.BROWSER_DEBUG_CAPTURE) return
  if (page.isClosed()) return

  try {
    const fp = await evaluateFingerprint(page)
    if (!fp) return
    const summary = summarizeFingerprint(fp)

    console.log(
      `[FingerprintProbe:${label}] verdict=${summary.verdict} ` +
        `cdpRuntimeLeak=${summary.cdp_runtime_leak} ` +
        `platform=${summary.platform} webdriver=${summary.webdriver} ` +
        `winFonts=${summary.win_fonts_present}/${fp.fonts.windowsProbed} ` +
        `linFonts=${summary.lin_fonts_present}/${fp.fonts.linuxProbed} ` +
        `glRenderer=${summary.webgl_renderer ?? "?"} ` +
        `dpr=${summary.dpr} screen=${summary.screen} inner=${summary.inner}`
    )

    const dir = PathManager.getInstance().getHtmlSnapshotsPath()
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    const jsonPath = path.join(dir, `${Date.now()}_fingerprint_${label}.json`)
    await fs.writeFile(jsonPath, JSON.stringify({ label, verdict: summary.verdict, ...fp }, null, 2))
    console.log(`[FingerprintProbe:${label}] dump written: ${path.basename(jsonPath)}`)

    try {
      const shot = path.join(dir, `${Date.now()}_fingerprint_${label}.png`)
      await page.screenshot({ path: shot, timeout: 10_000 })
    } catch (e) {
      console.warn(`[FingerprintProbe:${label}] screenshot failed:`, formatError(e))
    }
  } catch (error) {
    console.warn(`[FingerprintProbe:${label}] probe failed:`, formatError(error))
  }
}
