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
 *
 * Output is a JSON blob + a screenshot in the html-snapshots dir, already
 * uploaded to s3://<logs-bucket>/<uuid>/. Gated on BROWSER_DEBUG_CAPTURE, off by
 * default, pure read-only diagnostic — it changes nothing the page can observe.
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

/**
 * Capture the runtime fingerprint once. `label` distinguishes call sites in the
 * filename (e.g. "zoom_prejoin"). Never throws — diagnostics must not break join.
 */
export async function captureFingerprint(page: Page, label: string): Promise<void> {
  if (!envVars.BROWSER_DEBUG_CAPTURE) return
  if (page.isClosed()) return

  try {
    const fp = await page.evaluate(
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

        return {
          navigator: navigatorInfo,
          webgl: readGl("webgl"),
          webgl2: readGl("webgl2"),
          fonts: {
            windowsProbed: winFonts.length,
            windowsPresent: detectFonts(winFonts).present,
            linuxProbed: linFonts.length,
            linuxPresent: detectFonts(linFonts).present,
            documentFontsSize: (document as unknown as { fonts?: { size?: number } }).fonts?.size ?? null
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
    )

    // Coherence verdict: Windows UA/platform but Linux fonts present and no
    // Windows fonts = the mixed-OS tell. Logged inline so it shows in the bot
    // log without downloading the JSON.
    const claimsWindows =
      /windows/i.test(String(fp.navigator.userAgent)) ||
      String(fp.navigator.platform).startsWith("Win")
    const winFontCount = fp.fonts.windowsPresent.length
    const linFontCount = fp.fonts.linuxPresent.length
    const verdict = claimsWindows && winFontCount === 0 && linFontCount > 0 ? "MIXED-OS-TELL" : "ok"

    console.log(
      `[FingerprintProbe:${label}] verdict=${verdict} ` +
        `platform=${fp.navigator.platform} webdriver=${fp.navigator.webdriver} ` +
        `winFonts=${winFontCount}/${fp.fonts.windowsProbed} linFonts=${linFontCount}/${fp.fonts.linuxProbed} ` +
        `glRenderer=${fp.webgl?.unmaskedRenderer ?? fp.webgl?.renderer ?? "?"} ` +
        `dpr=${fp.geometry.dpr} screen=${fp.geometry.screen} inner=${fp.geometry.inner}`
    )

    const dir = PathManager.getInstance().getHtmlSnapshotsPath()
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    const jsonPath = path.join(dir, `${Date.now()}_fingerprint_${label}.json`)
    await fs.writeFile(jsonPath, JSON.stringify({ label, verdict, ...fp }, null, 2))
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
