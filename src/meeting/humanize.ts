// Humanized UI interaction for the Google Meet join flow.
//
// Why this exists: Google Meet's anti-bot heuristics flag the default
// Playwright interaction pattern — synthetic clicks that teleport to the exact
// element center with zero pointer travel, and `input.fill()` that injects a
// whole string in one tick with no keystroke timing. Real users move a cursor
// along a curved, variable-speed path and type one key at a time with jitter.
//
// This module reproduces that human-ness in Playwright (the equivalent of
// attendee-labs/attendee#847, which replays mocap mouse paths + jittered typing
// on the Python/X11 side): cubic-bézier cursor paths with eased speed and
// micro-jitter, interior (non-center) click points with a press/release dwell,
// and per-character typing with thinking pauses and the occasional corrected
// typo. It is the default join path; callers fall back to the instant path only
// if a humanized step throws, so join reliability is never regressed.

import type { Page, Locator } from "@playwright/test"

// --- tunables -------------------------------------------------------------

const HUMANIZE = {
  // mouse path
  minSteps: 18,
  maxSteps: 42,
  pxPerStep: 9, // more distance => more samples
  overshootDistancePx: 220, // only overshoot on travels longer than this
  // click
  clickDwellMs: [45, 120] as const,
  settleBeforeClickMs: [60, 160] as const,
  // typing
  keyDelayMs: [70, 185] as const,
  thinkingPauseChance: 0.12,
  thinkingPauseMs: [180, 520] as const,
  typoChance: 0.04
}

// --- low-level helpers ----------------------------------------------------

// Playwright's mouse is stateful but exposes no position getter, so we track it
// ourselves. Seeded lazily to a plausible resting point inside the viewport.
let cursor: { x: number; y: number } | null = null

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, Math.round(ms))))
const rand = (min: number, max: number) => min + Math.random() * (max - min)
const randInt = (min: number, max: number) => Math.round(rand(min, max))
const pick = <T,>(range: readonly [T, T]) => rand(range[0] as number, range[1] as number)

// Box–Muller gaussian, clamped to [-1, 1]; used to bias click points toward an
// element's center without ever landing dead-center every time.
function gaussianUnit(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.34
  return Math.max(-1, Math.min(1, n))
}

// Ease-in-out so the cursor accelerates away from the origin and decelerates
// into the target, like a real hand movement.
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

function cubicBezier(
  t: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number
): number {
  const mt = 1 - t
  return mt ** 3 * p0 + 3 * mt ** 2 * t * p1 + 3 * mt * t ** 2 * p2 + t ** 3 * p3
}

function viewport(page: Page): { width: number; height: number } {
  return page.viewportSize() ?? { width: 1280, height: 720 }
}

function seedCursor(page: Page): { x: number; y: number } {
  if (!cursor) {
    const vp = viewport(page)
    // Start somewhere in the lower-center, where a hand would rest.
    cursor = { x: rand(vp.width * 0.35, vp.width * 0.65), y: rand(vp.height * 0.6, vp.height * 0.85) }
  }
  return cursor
}

// --- public API -----------------------------------------------------------

/**
 * Move the virtual cursor to (targetX, targetY) along a curved, variable-speed
 * path with per-step jitter and (for longer travels) a slight overshoot and
 * correction. Updates the tracked cursor position.
 */
export async function humanMove(page: Page, targetX: number, targetY: number): Promise<void> {
  const start = seedCursor(page)
  const vp = viewport(page)
  const tx = Math.max(1, Math.min(vp.width - 1, targetX))
  const ty = Math.max(1, Math.min(vp.height - 1, targetY))

  const dist = Math.hypot(tx - start.x, ty - start.y)
  if (dist < 2) {
    cursor = { x: tx, y: ty }
    await page.mouse.move(tx, ty)
    return
  }

  // Two control points offset perpendicular to the travel direction give a
  // natural arc; the offset magnitude scales with distance.
  const nx = -(ty - start.y) / dist
  const ny = (tx - start.x) / dist
  const bow = rand(0.08, 0.22) * dist * (Math.random() < 0.5 ? 1 : -1)
  const c1x = start.x + (tx - start.x) * 0.33 + nx * bow
  const c1y = start.y + (ty - start.y) * 0.33 + ny * bow
  const c2x = start.x + (tx - start.x) * 0.66 + nx * bow * rand(0.4, 0.9)
  const c2y = start.y + (ty - start.y) * 0.66 + ny * bow * rand(0.4, 0.9)

  const steps = Math.max(
    HUMANIZE.minSteps,
    Math.min(HUMANIZE.maxSteps, Math.round(dist / HUMANIZE.pxPerStep))
  )

  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps)
    const jitter = i < steps ? rand(-1.2, 1.2) : 0 // settle exactly on the final point
    const x = cubicBezier(t, start.x, c1x, c2x, tx) + jitter
    const y = cubicBezier(t, start.y, c1y, c2y, ty) + jitter
    await page.mouse.move(x, y)
    await sleep(rand(4, 13))
  }

  // Occasional overshoot + correction on longer moves.
  if (dist > HUMANIZE.overshootDistancePx && Math.random() < 0.5) {
    const ox = tx + rand(-1, 1) * 6
    const oy = ty + rand(-1, 1) * 6
    await page.mouse.move(ox, oy)
    await sleep(rand(20, 60))
    await page.mouse.move(tx, ty)
  }

  cursor = { x: tx, y: ty }
}

/**
 * Move the cursor to a plausible idle position. Call once before navigating to
 * the meeting so the very first interaction isn't a cold teleport.
 */
export async function humanPrePosition(page: Page): Promise<void> {
  try {
    const vp = viewport(page)
    await humanMove(page, rand(vp.width * 0.3, vp.width * 0.7), rand(vp.height * 0.3, vp.height * 0.7))
  } catch {
    // pre-positioning is best-effort
  }
}

/**
 * Human click on a locator: scroll into view, pick an interior point biased
 * toward (but never exactly at) center, travel there along a curved path, settle
 * briefly, then press/release with a realistic dwell. Throws if the element has
 * no box so the caller can fall back to the instant click path.
 */
export async function humanClick(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
  const box = await locator.boundingBox({ timeout: 2000 })
  if (!box) throw new Error("humanClick: element has no bounding box")

  // Gaussian-distributed interior point: mostly central, occasionally off to a
  // side, never the same pixel twice. Keep a small margin off the edges.
  const mx = box.width * 0.32
  const my = box.height * 0.32
  const px = box.x + box.width / 2 + gaussianUnit() * mx
  const py = box.y + box.height / 2 + gaussianUnit() * my

  await humanMove(page, px, py)
  await sleep(pick(HUMANIZE.settleBeforeClickMs))
  await page.mouse.down()
  await sleep(pick(HUMANIZE.clickDwellMs))
  await page.mouse.up()
}

/**
 * Human type into a locator: focus it with a human click, clear any existing
 * value, then emit one character at a time with jittered delays, occasional
 * thinking pauses, and a rare mistyped-then-corrected key. Throws on focus
 * failure so the caller can fall back to `fill()`.
 */
export async function humanType(page: Page, locator: Locator, text: string): Promise<void> {
  await humanClick(page, locator)
  await sleep(rand(80, 200))

  // Clear whatever is there (placeholder selection, stale value).
  await page.keyboard.press("ControlOrMeta+a").catch(() => {})
  await sleep(rand(40, 110))
  await page.keyboard.press("Backspace").catch(() => {})
  await sleep(rand(60, 160))

  const neighbors = "abcdefghijklmnopqrstuvwxyz"
  for (const ch of text) {
    if (Math.random() < HUMANIZE.typoChance && /[a-z]/i.test(ch)) {
      const wrong = neighbors[randInt(0, neighbors.length - 1)]
      await page.keyboard.type(wrong)
      await sleep(pick(HUMANIZE.keyDelayMs))
      await page.keyboard.press("Backspace")
      await sleep(rand(90, 220))
    }

    await page.keyboard.type(ch)
    await sleep(pick(HUMANIZE.keyDelayMs))

    if (Math.random() < HUMANIZE.thinkingPauseChance) {
      await sleep(pick(HUMANIZE.thinkingPauseMs))
    }
  }
}
