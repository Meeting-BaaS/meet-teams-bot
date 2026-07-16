import type { Locator, Page } from "@playwright/test"
import { sleep } from "./sleep"

/**
 * Human-input helpers for the bot-scrutinised parts of a join (mouse clicks,
 * name typing). Kept in one place so every provider drives real, trusted input
 * the same way.
 *
 * IMPORTANT — do NOT re-implement mouse-path smoothing here. On stealthfox the
 * patched Juggler already turns a single `mouse.move` into a human Bezier path
 * (gated on the `stealthfox.humanize` pref). Adding our own multi-step move on
 * top made every Join click crawl (each intermediate step got Bezier-expanded
 * again). So we issue ONE move and let the browser humanise it.
 */

const rand = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min))

// QWERTY neighbours, used to make a realistic typo (a fat-finger to an adjacent
// key) rather than a random glyph. Only letters — digits/space/punctuation skip
// the typo path.
const ADJACENT: Record<string, string> = {
  a: "sqwz", b: "vghn", c: "xdfv", d: "serfcx", e: "wsdr", f: "drtgvc",
  g: "ftyhbv", h: "gyujnb", i: "ujko", j: "huikmn", k: "jiolm", l: "kop",
  m: "njk", n: "bhjm", o: "iklp", p: "ol", q: "wa", r: "edft", s: "awedxz",
  t: "rfgy", u: "yhji", v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx"
}

/**
 * Click a target with a real, trusted mouse: move to a slightly jittered point
 * inside it (one move — stealthfox curves it), brief press/release. This also
 * sidesteps locator.click()'s actionability check, which reports some Zoom
 * buttons as "not visible" on Firefox. Returns false if the box can't be
 * resolved so the caller can fall back.
 */
export async function humanClick(page: Page, locator: Locator): Promise<boolean> {
  try {
    const box = await locator.boundingBox({ timeout: 4000 })
    if (!box || box.width === 0 || box.height === 0) return false
    const x = box.x + box.width / 2 + (Math.random() - 0.5) * Math.min(box.width * 0.3, 12)
    const y = box.y + box.height / 2 + (Math.random() - 0.5) * Math.min(box.height * 0.3, 6)
    await page.mouse.move(x, y)
    await sleep(rand(40, 110))
    await page.mouse.down()
    await sleep(rand(30, 80))
    await page.mouse.up()
    return true
  } catch {
    return false
  }
}

/**
 * Type text like a person: variable per-key cadence and an occasional
 * fat-finger to an adjacent key that's immediately backspaced and corrected.
 * Typos are capped (1 for short strings, 2 for longer) so it stays quick — a
 * 13-char name is well under ~2s. Assumes the target field is already focused.
 */
export async function humanType(page: Page, text: string): Promise<void> {
  let typos = 0
  const maxTypos = text.length > 6 ? 2 : 1
  for (const ch of text) {
    const lower = ch.toLowerCase()
    const neighbours = ADJACENT[lower]
    if (typos < maxTypos && neighbours && Math.random() < 0.12) {
      typos++
      let wrong = neighbours[Math.floor(Math.random() * neighbours.length)]
      if (ch !== lower) wrong = wrong.toUpperCase()
      await page.keyboard.type(wrong)
      await sleep(rand(110, 240)) // notice the mistake
      await page.keyboard.press("Backspace")
      await sleep(rand(70, 150))
    }
    await page.keyboard.type(ch)
    await sleep(rand(45, 120))
  }
}
