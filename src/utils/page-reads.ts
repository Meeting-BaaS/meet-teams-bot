import type { Page } from "@playwright/test"

/** Raised when a bounded page read runs out of time. */
export class PageReadTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not settle within ${timeoutMs}ms`)
    this.name = "PageReadTimeoutError"
  }
}

/** Bound a Playwright read that has no timeout of its own. The call itself isn't cancelled. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PageReadTimeoutError(label, timeoutMs)), timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** stealthfox ignores bypassCSP on Zoom, so main-world evaluate fails "blocked by CSP". */
export function isCspEvaluateBlock(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /blocked by CSP/i.test(message)
}

export const ISOLATED_READ_TIMEOUT_MS = 3_000

/** Lowercased visible text via Playwright's isolated world (not subject to page CSP). */
export async function readVisibleTextIsolated(
  page: Page,
  timeoutMs: number = ISOLATED_READ_TIMEOUT_MS
): Promise<string> {
  try {
    const text = await page.locator("body").innerText({ timeout: timeoutMs })
    return text.toLowerCase()
  } catch {
    return ""
  }
}

/** Matching-element count through the isolated world, bounded; 0 when unreadable. */
export async function countIsolated(
  page: Page,
  selector: string,
  timeoutMs: number = ISOLATED_READ_TIMEOUT_MS
): Promise<number> {
  try {
    return await withTimeout(page.locator(selector).count(), timeoutMs, `count(${selector})`)
  } catch {
    return 0
  }
}
