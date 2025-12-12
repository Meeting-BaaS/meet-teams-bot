import { Page } from '@playwright/test'
import { MeetingEndReason } from '../state-machine/types'

/**
 * Generic Meeting State Detection Utility
 * Functional approach using types and closures
 */

export type MeetingPageState = 'in_meeting' | 'waiting_room' | 'denied' | 'unknown'

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
}

export type StateDetectionConfig = {
    providerName: string
    denialPatterns: DenialPattern[]
    waitingRoomPattern?: SelectorPattern
    inMeetingPattern: SelectorPattern
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
    checkVisibility: boolean = false,
): Promise<{ count: number; matched: string[] }> {
    let foundCount = 0
    const matchedSelectors: string[] = []
    for (const selector of selectors) {
        try {
            const count = await page.locator(selector).count().catch(() => 0)
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
        } catch (e) {
            // Continue checking other indicators
        }
    }
    return { count: foundCount, matched: matchedSelectors }
}

/**
 * Factory function to create a state detector with captured config
 * Returns an object with detection methods (closure pattern)
 */
export const createStateDetector = (
    config: StateDetectionConfig,
): MeetingStateDetector => {
    const detector: MeetingStateDetector = {
        isDenied: async (page) => {
            try {
                for (const pattern of config.denialPatterns) {
                    for (const text of pattern.texts) {
                        const element = page.locator(`text=${text}`)
                        if ((await element.count()) > 0) {
                            return {
                                state: 'denied',
                                matched: true,
                                matchedText: text,
                                pattern,
                            }
                        }
                    }
                }
                return { state: 'denied', matched: false }
            } catch (error) {
                console.error(
                    `[${config.providerName}] Error checking denied state:`,
                    error,
                )
                return { state: 'denied', matched: false }
            }
        },

        isWaitingRoom: async (page) => {
            if (!config.waitingRoomPattern) {
                return { state: 'waiting_room', matched: false }
            }

            try {
                const pattern = config.waitingRoomPattern
                const result = await checkIndicators(
                    page,
                    pattern.selectors,
                    pattern.checkVisibility ?? false,
                )

                const matched = result.count >= pattern.threshold
                if (matched) {
                    console.log(
                        `[${config.providerName}] Waiting room threshold met: ${result.count}/${pattern.threshold} - Matched selectors:`,
                        result.matched,
                    )
                }

                return {
                    state: 'waiting_room',
                    matched,
                    count: result.count,
                    pattern,
                }
            } catch (error) {
                console.error(
                    `[${config.providerName}] Error checking waiting room:`,
                    error,
                )
                return { state: 'waiting_room', matched: false }
            }
        },

        isInMeeting: async (page) => {
            try {
                const pattern = config.inMeetingPattern
                const result = await checkIndicators(
                    page,
                    pattern.selectors,
                    pattern.checkVisibility ?? false,
                )

                const matched = result.count >= pattern.threshold
                if (matched) {
                    console.log(
                        `[${config.providerName}] In-meeting threshold met: ${result.count}/${pattern.threshold} - Matched selectors:`,
                        result.matched,
                    )
                }

                return {
                    state: 'in_meeting',
                    matched,
                    count: result.count,
                    pattern,
                }
            } catch (error) {
                console.error(
                    `[${config.providerName}] Error checking in meeting:`,
                    error,
                )
                return { state: 'in_meeting', matched: false }
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

                return { state: 'unknown', matched: false }
            } catch (error) {
                console.error(
                    `[${config.providerName}] Error in detectState:`,
                    error,
                )
                return { state: 'unknown', matched: false }
            }
        },
    }

    return detector
}
