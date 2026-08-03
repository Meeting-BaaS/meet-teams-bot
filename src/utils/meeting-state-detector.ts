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
 * Scans every leaf element (childElementCount === 0) for the denial texts with
 * the same semantics as Playwright's `text=` engine (case-insensitive,
 * whitespace-normalized substring), and returns the index into `texts` of the
 * highest-priority match — or -1. A match only counts if the element:
 *  - is NOT inside any `ignoreSelectors` subtree (checked via closest()), and
 *  - is actually rendered (non-zero getBoundingClientRect — same lesson as
 *    commit f429129f: hidden template DOM must not trigger detection).
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

  let best = -1
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let el: Element | null = root
  while (el) {
    if (el.childElementCount === 0 && el.textContent) {
      const haystack = normalize(el.textContent)
      if (haystack) {
        // Lowest matching index = highest-priority pattern (config order)
        let matchedIndex = -1
        const limit = best === -1 ? needles.length : best
        for (let i = 0; i < limit; i++) {
          if (needles[i] && haystack.includes(needles[i])) {
            matchedIndex = i
            break
          }
        }
        if (matchedIndex !== -1) {
          let ignored = false
          for (const selector of args.ignoreSelectors) {
            try {
              if (el.closest(selector)) {
                ignored = true
                break
              }
            } catch (_e) {
              // Invalid selector must never break end-of-meeting detection
            }
          }
          if (!ignored) {
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              best = matchedIndex
              if (best === 0) return 0
            }
          }
        }
      }
    }
    el = walker.nextNode() as Element | null
  }
  return best
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
