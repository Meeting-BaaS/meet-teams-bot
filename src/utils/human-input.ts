// OS-level human-like input via xdotool. Used in the Meet join flow so clicks
// and keystrokes dispatch through X11 instead of Playwright's CDP layer —
// Google Meet's reCAPTCHA Enterprise scoring distinguishes between the two.
//
// Coordinates: the bot launches the browser with --window-position=0,0 in an
// Xvfb display (browser.ts:30-32), so screen-X equals viewport-X. Vertically,
// the browser chrome (URL bar + tab strip) consumes ~140px at the top of the
// window, so screen-Y = viewport-Y + CHROME_TOP_OFFSET.
//
// xdotool is installed in both the runtime Docker image (dockerfile.meet-teams-bot)
// and via the dev dep checker (scripts/check-start-deps.sh) — its absence is
// not a supported state. The fallback below exists for *transient* runtime
// failures (X11 hiccups, momentary DISPLAY issues, xdotool process crashes):
// on per-call failure the individual interaction falls back to Playwright,
// the failure is logged, and the *next* call retries xdotool fresh. There is
// no sticky session-wide "xdotool is broken" flag, because the failures we
// actually expect to see are transient.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { Locator, Page } from "@playwright/test"
import { envVars } from "../config/env-vars"
import { MocapManager } from "./mocap-manager"

const execFileAsync = promisify(execFile)

// Window: 1280x860 (viewport 1280x720, chrome 140) or 1920x1220 (viewport 1920x1080,
// chrome 140). Constant across both resolutions.
const CHROME_TOP_OFFSET = 140

const XDOTOOL_ENV = { ...process.env, DISPLAY: envVars.DISPLAY }

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// xdotool call that returns false on failure (instead of throwing). Each
// invocation is independent — a failure here triggers the caller's Playwright
// fallback for *this* interaction only; the next call retries xdotool.
async function xdoOk(args: string[]): Promise<boolean> {
  try {
    await execFileAsync("xdotool", args, { env: XDOTOOL_ENV })
    return true
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    console.error(
      `[human-input] xdotool call failed; using Playwright fallback for this interaction. cmd=xdotool ${args[0]} error=${msg}`
    )
    return false
  }
}

// Returns null on xdotool failure (caller bypasses the trajectory replay and
// falls back to Playwright click).
async function getMouseLocation(): Promise<{ x: number; y: number } | null> {
  try {
    const { stdout } = await execFileAsync("xdotool", ["getmouselocation"], {
      env: XDOTOOL_ENV
    })
    const m = stdout.match(/x:(-?\d+)\s+y:(-?\d+)/)
    if (!m) return { x: 0, y: 0 }
    return { x: Number(m[1]), y: Number(m[2]) }
  } catch {
    return null
  }
}

// Relative mouse move (replays a recorded per-event delta). `--` guards against
// negative deltas being parsed as flags.
async function xdoMoveRel(dx: number, dy: number): Promise<boolean> {
  return xdoOk(["mousemove_relative", "--", String(dx), String(dy)])
}

async function xdoMouseDown(): Promise<boolean> {
  return xdoOk(["mousedown", "1"])
}

async function xdoMouseUp(): Promise<boolean> {
  return xdoOk(["mouseup", "1"])
}

// ===== Mocap (recorded human motion) replay =====
// Lazily build the MocapManager once per process for the active resolution.
// `null` means "no recordings available" (e.g. unsupported resolution or files
// missing) — callers then fall back to synthesised motion / Playwright.
let mocapManager: MocapManager | null | undefined

function getMocapManager(): MocapManager | null {
  if (mocapManager === undefined) {
    try {
      const height = envVars.RESOLUTION === "1080" ? 1080 : 720
      const m = new MocapManager(height)
      mocapManager = m.sequenceCount > 0 ? m : null
      if (mocapManager === null) {
        console.warn("[human-input] no mocap sequences loaded; using fallback input")
      }
    } catch (e) {
      console.error("[human-input] mocap init failed; using fallback input:", formatXdoErr(e))
      mocapManager = null
    }
  }
  return mocapManager
}

function formatXdoErr(e: unknown): string {
  return (e as Error)?.message ?? String(e)
}

// Seed the cursor to the recording's start position before the first humanised
// interaction, so the relative-delta replays begin from a realistic spot. No-op
// when mocap is unavailable.
export async function positionMouseForHumanizedInteraction(): Promise<void> {
  const pos = getMocapManager()?.getInitialMousePosition()
  if (!pos) return
  await xdoOk(["mousemove", "--sync", String(pos[0]), String(pos[1])])
  console.log(`[human-input] seeded mouse at (${pos[0]}, ${pos[1]})`)
}

// Navigate to `locator` by replaying a recorded human trajectory whose endpoint
// lands on the element, then click. Returns false (so the caller falls back) if
// mocap is unavailable, no sequence lands on the target, or xdotool fails
// mid-replay. The browser runs at window-position 0,0 in Xvfb (browser.ts), so
// screen-X == viewport-X and screen-Y == viewport-Y + CHROME_TOP_OFFSET.
async function mocapNavigateAndClick(
  locator: Locator,
  opts: ClickOptions = {}
): Promise<boolean> {
  const mocap = getMocapManager()
  if (!mocap) return false

  const start = await getMouseLocation()
  if (!start) return false

  const box = await locator.boundingBox()
  if (!box || box.width <= 0 || box.height <= 0) return false

  const rectLeft = Math.round(box.x)
  const rectRight = Math.round(box.x + box.width)
  const rectTop = Math.round(box.y + CHROME_TOP_OFFSET)
  const rectBottom = Math.round(box.y + box.height + CHROME_TOP_OFFSET)

  const page = locator.page()
  const handle = await locator.elementHandle({ timeout: 2000 }).catch(() => null)

  // Try several candidates; prefer a natural landing, and verify via
  // elementFromPoint that the endpoint actually resolves to the target element.
  const MAX_ATTEMPTS = 10
  // For high-value clicks, start stretching as soon as natural lookups miss:
  // findRandomSequenceLandingInRect is deterministically empty when nothing lands
  // in-rect, so spinning attempts on it is wasted. Otherwise stretch only as a
  // last resort (stretch is randomised among the closest candidates, so repeated
  // attempts get different gestures to verify).
  const stretchFrom = opts.preferMocap ? 1 : MAX_ATTEMPTS - 3
  let chosen: ReturnType<MocapManager["findRandomSequenceLandingInRect"]> = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let usedStretch = false
    let candidate = mocap.findRandomSequenceLandingInRect(
      start.x,
      start.y,
      rectLeft,
      rectTop,
      rectRight,
      rectBottom
    )
    if (!candidate && attempt >= stretchFrom) {
      candidate = mocap.findClosestSequenceWithStretch(
        start.x,
        start.y,
        rectLeft,
        rectTop,
        rectRight,
        rectBottom
      )
      usedStretch = candidate !== null
    }
    if (!candidate) continue

    // Without an element handle we can't verify the landing via elementFromPoint.
    // A natural (findRandomSequenceLandingInRect) candidate is guaranteed in-rect,
    // so it's safe to trust; a stretched one only aims at the rect centre with
    // bounded distortion and may land off-target, so skip it and let the caller
    // fall back to a (correct) Playwright click.
    if (!handle) {
      if (usedStretch) continue
      chosen = candidate
      break
    }

    const endViewportX = start.x + candidate.totalDx
    const endViewportY = start.y + candidate.totalDy - CHROME_TOP_OFFSET
    const onTarget = await page
      .evaluate(
        ({ x, y, el }) => {
          const e = document.elementFromPoint(x, y)
          return !!e && (e === el || el.contains(e))
        },
        { x: endViewportX, y: endViewportY, el: handle }
      )
      .catch(() => false)

    // Only commit to a sequence whose endpoint actually resolves to the target.
    // Replaying an unverified one would click empty space; better to fall back
    // to a (correct, if non-humanised) Playwright click.
    if (onTarget) {
      chosen = candidate
      break
    }
  }

  if (!chosen) return false

  console.log(
    `[human-input] mocap replay: ${chosen.movements.length} movements, totalDx=${chosen.totalDx}, totalDy=${chosen.totalDy}`
  )

  for (const mov of chosen.movements) {
    if (mov.dt > 0) await sleep(mov.dt * 1000)
    if (mov.dx || mov.dy) {
      if (!(await xdoMoveRel(mov.dx, mov.dy))) return false
    }
  }

  if (chosen.clickDownDt > 0) await sleep(chosen.clickDownDt * 1000)
  if (!(await xdoMouseDown())) return false
  if (chosen.clickUpDt > 0) await sleep(chosen.clickUpDt * 1000)
  if (!(await xdoMouseUp())) return false

  return true
}

// Converts an xdotool-style key combo ("ctrl+e", "Escape", "Return") into the
// Playwright keyboard.press format ("Control+E", "Escape", "Enter") so the
// fallback path produces the same semantic keypress.
function toPlaywrightKey(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      const lower = part.toLowerCase()
      if (lower === "ctrl") return "Control"
      if (lower === "shift") return "Shift"
      if (lower === "alt") return "Alt"
      if (lower === "meta" || lower === "super") return "Meta"
      if (lower === "return") return "Enter"
      // Single ASCII letter — uppercase for Playwright's KeyX form
      if (/^[a-z]$/.test(part)) return part.toUpperCase()
      return part
    })
    .join("+")
}

// ===== Public API =====

export type ClickOptions = {
  // High-value click (e.g. the name field and the Join button): engage the
  // stretch/retarget fallback as soon as natural lookups miss, instead of only
  // as a last resort, so the recorded human motion actually fires on the
  // interactions Google scores most. Still gated on elementFromPoint
  // verification, so it never clicks off-target.
  preferMocap?: boolean
}

export async function humanClick(locator: Locator, opts: ClickOptions = {}): Promise<void> {
  // Keep these short: in the join flow the element is normally already present,
  // so long waits only stack latency onto the (common) mocap-miss path.
  await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
  await locator.waitFor({ state: "visible", timeout: 3000 }).catch(() => {})

  // Preferred: replay a recorded human trajectory landing on the element.
  if (await mocapNavigateAndClick(locator, opts)) return

  // Mocap miss → fast, correct Playwright click. We intentionally do NOT run a
  // synthesised trajectory here: in prod it cost ~5-16s per miss and never moved
  // the detection signal — the recorded mocap motion is the only part that helps,
  // so when it can't fire we just click directly.
  await locator.click({ timeout: 5000 })
}

export type TypeOptions = {
  // Per-character delay range (ms). Default 60-180.
  charDelayMin?: number
  charDelayMax?: number
  // Probability of an extra "thinking" pause between any two characters.
  thinkPauseProb?: number
  thinkPauseMin?: number
  thinkPauseMax?: number
  // If true (default), click the target first and select-all + delete to
  // clear any pre-existing content before typing. Matches the existing
  // page.fill(INPUT, "") → page.fill(INPUT, name) pattern.
  clearFirst?: boolean
}

// Split `text` into grapheme clusters so emoji, combining marks, and CJK
// characters are typed as one user-perceived unit each. Iterating by UTF-16
// code unit (text[i]) would slice surrogate pairs and break combining marks
// — important since ~17% of bot names in prod are non-ASCII (Japanese,
// Hebrew, accented Latin, Cyrillic).
function segmentGraphemes(text: string): string[] {
  // Intl.Segmenter is available in Node 18+; we run on 22 per Dockerfile.
  // biome-ignore lint/suspicious/noExplicitAny: TODO: fix this
  const SegmenterCtor: typeof Intl.Segmenter | undefined = (Intl as any).Segmenter
  if (typeof SegmenterCtor === "function") {
    const segmenter = new SegmenterCtor(undefined, { granularity: "grapheme" })
    const out: string[] = []
    for (const part of segmenter.segment(text)) out.push(part.segment)
    return out
  }
  // Fallback to code-point iteration — better than code-unit iteration for
  // surrogate pairs, still imperfect for combining marks. Should not trigger
  // on Node 18+; kept for safety.
  return Array.from(text)
}

export async function humanType(
  locator: Locator,
  text: string,
  opts: TypeOptions = {}
): Promise<void> {
  const clearFirst = opts.clearFirst ?? true

  // Focusing the field is a high-value, scored interaction (name entry), so bias
  // toward landing a real mocap gesture rather than a fast Playwright click.
  await humanClick(locator, { preferMocap: true })
  await sleep(rand(120, 280))

  if (clearFirst) {
    // Select-all + delete via xdotool; if either fails, fall back to
    // locator.fill("") which clears via CDP. Acceptable for a clear-only op.
    const selected = await xdoOk(["key", "--clearmodifiers", "ctrl+a"])
    if (selected) {
      await sleep(rand(40, 100))
      await xdoOk(["key", "--clearmodifiers", "Delete"])
      await sleep(rand(80, 160))
    } else {
      await locator.fill("")
    }
  }

  const charMin = opts.charDelayMin ?? 60
  const charMax = opts.charDelayMax ?? 180
  const thinkProb = opts.thinkPauseProb ?? 0.08
  const thinkMin = opts.thinkPauseMin ?? 300
  const thinkMax = opts.thinkPauseMax ?? 600

  const graphemes = segmentGraphemes(text)
  for (let i = 0; i < graphemes.length; i++) {
    const ok = await xdoOk(["type", "--clearmodifiers", "--delay", "0", graphemes[i]])
    if (!ok) {
      // xdotool dropped a keystroke. Finish the remaining graphemes via
      // Playwright so the field still ends up with the full value. Single
      // partial-input failure means we don't necessarily abandon xdotool for
      // the rest of the session, but for this string we just want to land
      // the value.
      const remaining = graphemes.slice(i).join("")
      await locator.page().keyboard.type(remaining, { delay: rand(60, 180) })
      return
    }
    if (i < graphemes.length - 1) {
      await sleep(rand(charMin, charMax))
      if (Math.random() < thinkProb) {
        await sleep(rand(thinkMin, thinkMax))
      }
    }
  }
}

// e.g. humanKey("Escape"), humanKey("ctrl+e"), humanKey("Return"). Optional
// `page` lets us fall back to keyboard.press if the xdotool call fails for
// this interaction — callers in the Meet pre-join flow should always pass it.
export async function humanKey(combo: string, page?: Page): Promise<void> {
  if (await xdoOk(["key", "--clearmodifiers", combo])) return
  if (page) {
    await page.keyboard.press(toPlaywrightKey(combo))
  } else {
    console.warn(
      `[human-input] humanKey(${combo}): xdotool failed and no page provided for fallback — keypress dropped.`
    )
  }
}
