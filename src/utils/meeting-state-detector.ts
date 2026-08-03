import type { Locator, Page } from "@playwright/test"
import type { MeetingEndReason } from "../state-machine/types"

/**
 * Generic Meeting State Detection Utility
 * Functional approach using types and closures
 */

export type MeetingPageState = "in_meeting" | "waiting_room" | "denied" | "unknown"

export type DenialPattern = {
  texts: string[]
  reason?: MeetingEndReason
  logPrefix?: string
  errorMessage?: string
}

export type SelectorPattern = {
  selectors: string[]
  threshold: number
  checkVisibility?: boolean
  // This is not used for selector patterns
  reason?: never
  logPrefix?: never
  errorMessage?: never
}

export type StateDetectionConfig = {
  providerName: string
  denialPatterns: DenialPattern[]
  // Subtrees whose text must NEVER count as a denial match. Needed because
  // denial phrases are generic enough to appear in user-generated content:
  // the Zoom bot's own entry chat message contains "removed from the meeting",
  // which used to trip isDenied() ~200ms after joining and kill the bot.
  // Matched elements are discarded when `element.closest(selector)` hits any
  // of these selectors.
  denialIgnoreWithinSelectors?: string[]
  waitingRoomPattern?: SelectorPattern
  inMeetingPattern: SelectorPattern
  // Pre-join flow screens, each identified by any one of several selectors so a
  // single label/markup change doesn't strand the join. Consumed page-based via
  // patternLocator() (wait for the first match) rather than a blind retry loop.
  continueOnBrowserPattern?: SelectorPattern
  preJoinPattern?: SelectorPattern
}

export type StateDetectionResult = {
  state: MeetingPageState
  matched: boolean
  count?: number
  matchedText?: string
  pattern?: DenialPattern | SelectorPattern
}

export type MeetingStateDetector = {
  isDenied: (page: Page) => Promise<StateDetectionResult>
  isWaitingRoom: (page: Page) => Promise<StateDetectionResult>
  isInMeeting: (page: Page) => Promise<StateDetectionResult>
  detectState: (page: Page) => Promise<StateDetectionResult>
}

/**
 * Generic utility to check if selectors are present/visible on page
 */
async function checkIndicators(
  page: Page,
  selectors: string[],
  checkVisibility = false
): Promise<{ count: number; matched: string[] }> {
  let foundCount = 0
  const matchedSelectors: string[] = []
  for (const selector of selectors) {
    try {
      const count = await page
        .locator(selector)
        .count()
        .catch(() => 0)
      if (count > 0) {
        if (checkVisibility) {
          // Just check presence in DOM, not visibility
          // Useful when menus/modals might hide elements
          foundCount++
          matchedSelectors.push(selector)
        } else {
          const isVisible = await page
            .locator(selector)
            .first()
            .isVisible()
            .catch(() => false)
          if (isVisible) {
            foundCount++
            matchedSelectors.push(selector)
          }
        }
      }
    } catch (_e) {
      // Continue checking other indicators
    }
  }
  return { count: foundCount, matched: matchedSelectors }
}

/**
 * Runs INSIDE the page via page.evaluate — must stay fully self-contained
 * (no references to module scope, or Playwright's function serialization breaks).
 *
 * Mirrors Playwright's `text=` engine semantics (which the old locator-based
 * isDenied relied on): case-insensitive, whitespace-normalized SUBTREE-text
 * substring matching — so a phrase split across nested elements
 * (`You have <span>been removed</span> from the meeting`) still matches — and
 * pierces OPEN shadow roots. Returns the index into `texts` of the
 * highest-priority (lowest-index) match, or -1.
 *
 * For each needle, the INNERMOST matching elements (matching, with no matching
 * child element) are the candidates — mirroring Playwright's innermost-match
 * behavior — and a candidate only counts if it:
 *  - is NOT inside any `ignoreSelectors` subtree. Ancestry is walked across
 *    shadow boundaries (ShadowRoot → host), testing matches() at each hop;
 *  - is actually rendered: non-zero getBoundingClientRect (same lesson as
 *    commit f429129f: hidden template DOM must not trigger detection) AND
 *    computed `visibility: visible` (visibility:hidden keeps a non-zero rect).
 *
 * Subtree text is computed bottom-up in ONE post-order pass and memoized, so
 * the per-needle innermost search is just map lookups — not innerText per node.
 *
 * Exported for tests; production callers go through isDenied().
 */
export const findVisibleDenialTextIndex = (args: {
  texts: string[]
  ignoreSelectors: string[]
}): number => {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()
  const needles = args.texts.map(normalize)
  const root = document.body || document.documentElement
  if (!root) return -1

  // ── one post-order pass: normalized subtree text per element, entering
  //    open shadow roots ──────────────────────────────────────────────────
  const subtreeText = new Map<Element, string>()
  const collectText = (node: Element | ShadowRoot): string => {
    let raw = ""
    if (node instanceof Element && node.shadowRoot) {
      raw += ` ${collectText(node.shadowRoot)} `
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        raw += (child as Text).data
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        raw += collectText(child as Element)
      }
    }
    if (node instanceof Element) subtreeText.set(node, normalize(raw))
    return raw
  }
  collectText(root)

  // Child elements including those in an open shadow root
  const childElements = (el: Element): Element[] => {
    const kids: Element[] = []
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) kids.push(child)
    }
    for (const child of el.children) kids.push(child)
    return kids
  }

  // Innermost matching elements: subtree text matches the needle, but no child
  // element's does. Returns whether `el` matches; pushes innermost into `out`.
  const findInnermost = (el: Element, needle: string, out: Element[]): boolean => {
    const text = subtreeText.get(el)
    if (!text || !text.includes(needle)) return false
    let childMatched = false
    for (const child of childElements(el)) {
      if (findInnermost(child, needle, out)) childMatched = true
    }
    if (!childMatched) out.push(el)
    return true
  }

  // Ancestry walk that crosses shadow boundaries (ShadowRoot → host)
  const isIgnored = (el: Element): boolean => {
    let node: Node | null = el
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        for (const selector of args.ignoreSelectors) {
          try {
            if ((node as Element).matches(selector)) return true
          } catch (_e) {
            // Invalid selector must never break end-of-meeting detection
          }
        }
        node = node.parentNode
      } else if (node instanceof ShadowRoot) {
        node = node.host
      } else {
        node = node.parentNode
      }
    }
    return false
  }

  const isRendered = (el: Element): boolean => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const view = el.ownerDocument.defaultView || window
    return view.getComputedStyle(el).visibility === "visible"
  }

  // Needles in config order: the first one with a valid rendered match wins
  for (let i = 0; i < needles.length; i++) {
    if (!needles[i]) continue
    const candidates: Element[] = []
    findInnermost(root, needles[i], candidates)
    for (const candidate of candidates) {
      if (!isIgnored(candidate) && isRendered(candidate)) return i
    }
  }
  return -1
}

/**
 * Factory function to create a state detector with captured config
 * Returns an object with detection methods (closure pattern)
 */
export const createStateDetector = (config: StateDetectionConfig): MeetingStateDetector => {
  const detector: MeetingStateDetector = {
    isDenied: async (page) => {
      try {
        const allTexts: string[] = []
        for (const pattern of config.denialPatterns) {
          allTexts.push(...pattern.texts)
        }
        if (allTexts.length === 0) {
          return { state: "denied", matched: false }
        }

        // Single in-page pass instead of one locator round-trip per phrase
        const matchedIndex = await page.evaluate(findVisibleDenialTextIndex, {
          texts: allTexts,
          ignoreSelectors: config.denialIgnoreWithinSelectors ?? []
        })

        if (matchedIndex >= 0) {
          let offset = 0
          for (const pattern of config.denialPatterns) {
            if (matchedIndex < offset + pattern.texts.length) {
              return {
                state: "denied",
                matched: true,
                matchedText: pattern.texts[matchedIndex - offset],
                pattern
              }
            }
            offset += pattern.texts.length
          }
        }
        return { state: "denied", matched: false }
      } catch (error) {
        console.error(`[${config.providerName}] Error checking denied state:`, error)
        return { state: "denied", matched: false }
      }
    },

    isWaitingRoom: async (page) => {
      if (!config.waitingRoomPattern) {
        return { state: "waiting_room", matched: false }
      }

      try {
        const pattern = config.waitingRoomPattern
        const result = await checkIndicators(
          page,
          pattern.selectors,
          pattern.checkVisibility ?? false
        )

        const matched = result.count >= pattern.threshold
        if (matched) {
          console.log(
            `[${config.providerName}] Waiting room threshold met: ${result.count}/${pattern.threshold} - Matched selectors:`,
            result.matched
          )
        }

        return {
          state: "waiting_room",
          matched,
          count: result.count,
          pattern
        }
      } catch (error) {
        console.error(`[${config.providerName}] Error checking waiting room:`, error)
        return { state: "waiting_room", matched: false }
      }
    },

    isInMeeting: async (page) => {
      try {
        const pattern = config.inMeetingPattern
        const result = await checkIndicators(
          page,
          pattern.selectors,
          pattern.checkVisibility ?? false
        )

        const matched = result.count >= pattern.threshold
        if (matched) {
          console.log(
            `[${config.providerName}] In-meeting threshold met: ${result.count}/${pattern.threshold} - Matched selectors:`,
            result.matched
          )
        }

        return {
          state: "in_meeting",
          matched,
          count: result.count,
          pattern
        }
      } catch (error) {
        console.error(`[${config.providerName}] Error checking in meeting:`, error)
        return { state: "in_meeting", matched: false }
      }
    },

    detectState: async (page) => {
      try {
        // Check denial first (highest priority)
        const deniedResult = await detector.isDenied(page)
        if (deniedResult.matched) return deniedResult

        // Check waiting room
        const waitingRoomResult = await detector.isWaitingRoom(page)
        if (waitingRoomResult.matched) return waitingRoomResult

        // Check in meeting
        const inMeetingResult = await detector.isInMeeting(page)
        if (inMeetingResult.matched) return inMeetingResult

        return { state: "unknown", matched: false }
      } catch (error) {
        console.error(`[${config.providerName}] Error in detectState:`, error)
        return { state: "unknown", matched: false }
      }
    }
  }

  return detector
}

/**
 * Fold a SelectorPattern's selectors into ONE Playwright locator that matches ANY of
 * them (`.or()` chain). Lets callers wait page-based on a whole pattern with
 * `patternLocator(page, pattern).first().waitFor({ state: "visible" })` — multi-selector
 * and event-driven (resolves the instant one matches), no polling/retry loop. Throws on
 * an empty selector list (a pattern must have at least one selector).
 */
export const patternLocator = (page: Page, pattern: SelectorPattern): Locator =>
  pattern.selectors.map((s) => page.locator(s)).reduce((a, b) => a.or(b))
