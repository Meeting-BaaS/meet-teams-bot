import type { Locator, Page } from "@playwright/test"

/**
 * Randomized delay to simulate human reaction time.
 */
export function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs)
  return new Promise((resolve) => setTimeout(resolve, delay))
}

/**
 * Moves the mouse toward a locator's bounding box with a random offset,
 * using multiple intermediate steps to simulate a natural curve.
 */
export async function humanMoveTo(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) return

  // Pick a random point within the element, biased toward center
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4)
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4)

  // Get current mouse position (default to a random starting point if unknown)
  const startX = 100 + Math.random() * 200
  const startY = 100 + Math.random() * 200

  // Move in 5-12 steps with slight curve
  const steps = 5 + Math.floor(Math.random() * 8)
  const curveOffsetX = (Math.random() - 0.5) * 60
  const curveOffsetY = (Math.random() - 0.5) * 40

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    // Quadratic bezier-ish interpolation with a random control point
    const ct = 1 - t
    const midX = startX + curveOffsetX
    const midY = startY + curveOffsetY
    const x = ct * ct * startX + 2 * ct * t * midX + t * t * targetX
    const y = ct * ct * startY + 2 * ct * t * midY + t * t * targetY

    await page.mouse.move(x, y)
    await humanDelay(8, 25)
  }
}

/**
 * Moves to a locator and clicks it with human-like timing.
 */
export async function humanClick(page: Page, locator: Locator): Promise<void> {
  await humanMoveTo(page, locator)
  await humanDelay(80, 200)
  await locator.click()
}

/**
 * Types text character by character with random inter-key delays.
 * Simulates natural typing rhythm with occasional pauses.
 */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForSelector(selector, { timeout: 2000 })
  await page.focus(selector)
  await humanDelay(150, 350)

  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i], { delay: 0 })

    // Base inter-key delay
    let delay = 60 + Math.random() * 120

    // Occasional longer pause (simulates thinking / looking at keyboard)
    if (Math.random() < 0.08) {
      delay += 200 + Math.random() * 300
    }

    await humanDelay(delay * 0.8, delay * 1.2)
  }
}
