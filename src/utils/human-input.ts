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

import { execFile } from "child_process"
import { promisify } from "util"
import type { Locator, Page } from "@playwright/test"
import { MocapManager } from "./mocap-manager"

const execFileAsync = promisify(execFile)

// Window: 1280x860 (viewport 1280x720, chrome 140) or 1920x1220 (viewport 1920x1080,
// chrome 140). Constant across both resolutions.
const CHROME_TOP_OFFSET = 140

const XDOTOOL_ENV = { ...process.env, DISPLAY: process.env.DISPLAY || ":99" }

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
      const height = process.env.RESOLUTION === "1080" ? 1080 : 720
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
async function mocapNavigateAndClick(locator: Locator): Promise<boolean> {
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
  let chosen: ReturnType<MocapManager["findRandomSequenceLandingInRect"]> = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let candidate = mocap.findRandomSequenceLandingInRect(
      start.x,
      start.y,
      rectLeft,
      rectTop,
      rectRight,
      rectBottom
    )
    // Only stretch/rotate as a last resort, after natural lookups keep missing.
    if (!candidate && attempt >= MAX_ATTEMPTS - 3) {
      candidate = mocap.findClosestSequenceWithStretch(
        start.x,
        start.y,
        rectLeft,
        rectTop,
        rectRight,
        rectBottom
      )
    }
    if (!candidate) continue

    // Without an element handle we can't verify the landing, so trust the
    // geometric in-rect guarantee from findRandomSequenceLandingInRect.
    if (!handle) {
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

// ===== Trajectory library =====
// Each trajectory is a sequence of waypoints in (t, x, y) space:
//   t ∈ [0,1] — cumulative time fraction
//   x,y ∈ [0,1] — position fraction along start→target (with optional drift)
// Replay scales t to a total duration (jittered) and x/y to actual screen
// displacement, with small per-waypoint pixel jitter and time stretching.
// Synthesised to span human-shaped motion patterns: smooth-S, overshoot,
// curved drift, hesitation, choppy trackpad-style segments. Future work
// could replace these with recordings of real human cursor traces.

type Waypoint = { t: number; x: number; y: number }

const TRAJECTORIES: Waypoint[][] = [
  // 0: smooth-S, slow start and slow end
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.15, x: 0.05, y: 0.04 },
    { t: 0.35, x: 0.25, y: 0.2 },
    { t: 0.55, x: 0.55, y: 0.5 },
    { t: 0.75, x: 0.85, y: 0.82 },
    { t: 0.9, x: 0.97, y: 0.95 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ],
  // 1: slight overshoot then correction
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.2, x: 0.1, y: 0.12 },
    { t: 0.45, x: 0.4, y: 0.42 },
    { t: 0.7, x: 0.72, y: 0.75 },
    { t: 0.85, x: 0.95, y: 0.98 },
    { t: 0.93, x: 1.04, y: 1.06 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ],
  // 2: impatient — quick & direct
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.3, x: 0.35, y: 0.33 },
    { t: 0.65, x: 0.78, y: 0.8 },
    { t: 0.9, x: 0.97, y: 0.97 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ],
  // 3: curved — drifts above the line then returns
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.2, x: 0.18, y: 0.08 },
    { t: 0.4, x: 0.38, y: 0.28 },
    { t: 0.6, x: 0.6, y: 0.55 },
    { t: 0.8, x: 0.82, y: 0.8 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ],
  // 4: hesitant — pauses near midway
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.15, x: 0.2, y: 0.18 },
    { t: 0.35, x: 0.42, y: 0.4 },
    { t: 0.5, x: 0.52, y: 0.5 },
    { t: 0.62, x: 0.53, y: 0.51 },
    { t: 0.8, x: 0.78, y: 0.78 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ],
  // 5: bezier-shaped smooth
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.1, x: 0.02, y: 0.01 },
    { t: 0.25, x: 0.12, y: 0.1 },
    { t: 0.5, x: 0.5, y: 0.48 },
    { t: 0.75, x: 0.88, y: 0.9 },
    { t: 0.9, x: 0.98, y: 0.99 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ],
  // 6: opposite-curved — drifts below the line
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.2, x: 0.08, y: 0.18 },
    { t: 0.4, x: 0.28, y: 0.38 },
    { t: 0.6, x: 0.55, y: 0.6 },
    { t: 0.8, x: 0.8, y: 0.82 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ],
  // 7: shallow overshoot
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.25, x: 0.3, y: 0.28 },
    { t: 0.55, x: 0.65, y: 0.68 },
    { t: 0.78, x: 0.95, y: 0.96 },
    { t: 0.88, x: 1.03, y: 1.04 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ],
  // 8: ramped acceleration — slow then fast
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.25, x: 0.08, y: 0.06 },
    { t: 0.5, x: 0.25, y: 0.22 },
    { t: 0.7, x: 0.55, y: 0.52 },
    { t: 0.85, x: 0.8, y: 0.82 },
    { t: 0.95, x: 0.95, y: 0.95 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ],
  // 9: choppy trackpad-style — three distinct segments with stalls
  [
    { t: 0, x: 0, y: 0 },
    { t: 0.2, x: 0.3, y: 0.3 },
    { t: 0.3, x: 0.32, y: 0.32 },
    { t: 0.55, x: 0.7, y: 0.7 },
    { t: 0.65, x: 0.72, y: 0.72 },
    { t: 0.9, x: 0.97, y: 0.97 },
    { t: 1.0, x: 1.0, y: 1.0 }
  ]
]

// Returns false if any xdotool call failed mid-replay (caller falls back to
// a Playwright click); true if all waypoints dispatched successfully.
async function replayTrajectory(
  traj: Waypoint[],
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
  totalMs: number
): Promise<boolean> {
  const dx = targetX - startX
  const dy = targetY - startY
  const timeStretch = rand(0.9, 1.1)
  let lastT = 0
  for (let i = 0; i < traj.length; i++) {
    const wp = traj[i]
    const segmentMs = (wp.t - lastT) * totalMs * timeStretch
    lastT = wp.t
    // Per-waypoint pixel jitter — skip the endpoints so we land exactly on target
    const jx = i > 0 && i < traj.length - 1 ? rand(-2, 2) : 0
    const jy = i > 0 && i < traj.length - 1 ? rand(-2, 2) : 0
    const x = Math.round(startX + dx * wp.x + jx)
    const y = Math.round(startY + dy * wp.y + jy)
    if (segmentMs > 0) await sleep(segmentMs)
    if (!(await xdoOk(["mousemove", "--sync", String(x), String(y)]))) return false
  }
  return true
}

// ===== Public API =====

export type ClickOptions = {
  // Total motion time in ms (jittered within this range). Default 250-450.
  durationMin?: number
  durationMax?: number
  // Pause between landing on the target and pressing the mouse button.
  // Humans don't click instantly on arrival. Default 60-150ms.
  preClickDelayMin?: number
  preClickDelayMax?: number
}

export async function humanClick(locator: Locator, opts: ClickOptions = {}): Promise<void> {
  // Ensure the element is in view and visible before measuring its box.
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
  await locator.waitFor({ state: "visible", timeout: 5000 })

  // Preferred: replay a recorded human trajectory landing on the element.
  // Falls through to synthesised motion / Playwright when mocap is unavailable.
  if (await mocapNavigateAndClick(locator)) return

  const start = await getMouseLocation()
  if (start) {
    const box = await locator.boundingBox()
    if (box) {
      // Off-centre target (humans don't click pixel-perfect centre)
      const targetX = box.x + box.width / 2 + rand(-box.width * 0.25, box.width * 0.25)
      const targetY = box.y + box.height / 2 + rand(-box.height * 0.25, box.height * 0.25)
      const screenTargetX = Math.round(targetX)
      const screenTargetY = Math.round(targetY + CHROME_TOP_OFFSET)

      const traj = TRAJECTORIES[Math.floor(Math.random() * TRAJECTORIES.length)]
      const duration = rand(opts.durationMin ?? 250, opts.durationMax ?? 450)

      const moved = await replayTrajectory(
        traj,
        start.x,
        start.y,
        screenTargetX,
        screenTargetY,
        duration
      )
      if (moved) {
        await sleep(rand(opts.preClickDelayMin ?? 60, opts.preClickDelayMax ?? 150))
        if (await xdoOk(["click", "1"])) return
      }
    }
  }

  // Playwright fallback (this single interaction only; next humanClick will
  // retry xdotool). Reaches here when getMouseLocation, the trajectory
  // replay, or the final click failed — xdoOk has already logged.
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

  await humanClick(locator)
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
