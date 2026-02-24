import { BrowserContext, Page } from '@playwright/test'

import { MeetingEndReason } from '../state-machine/types'
import { MeetingProviderInterface } from '../types'

import { HtmlSnapshotService } from '../services/html-snapshot-service'
import { SimpleDialogObserver } from '../services/dialog-observer/simple-dialog-observer'
import { GLOBAL } from '../singleton'
import { parseMeetingUrlFromJoinInfos } from '../urlParser/meetUrlParser'
import { sleep } from '../utils/sleep'
import { formatError } from '../utils/Logger'
import { closeMeeting } from './meet/closeMeeting'
import { createStateDetector } from '../utils/meeting-state-detector'
import { MEET_STATE_CONFIG } from './meet-state-config'
import {
    enableMeetAudioCapture,
    verifyMeetAudioCapture,
} from './meet/audio-capture'

// Create a singleton detector instance for Google Meet
const meetStateDetector = createStateDetector(MEET_STATE_CONFIG)
const ENTRY_MESSAGE_TIMEOUT = 2000
const GRACE_PERIOD_MS = 1000 // Grace period after leaving waiting room before checking if in meeting

/**
 * Checks that the page is still on meet.google.com.
 * If the page navigated away (e.g. Google redirected to workspace.google.com
 * after showing "You can't join this video call"), sets a retryable error and throws.
 */
function assertOnMeetPage(page: Page): void {
    const url = page.url()
    if (url && !url.includes('meet.google.com')) {
        console.log(`Page is not on Google Meet: ${url}`)
        GLOBAL.setShouldRetry(true)
        GLOBAL.setError(
            MeetingEndReason.BotNotAccepted,
            `Google Meet denied entry - page redirected to: ${url}`,
        )
        throw new Error('Page navigated away from Google Meet')
    }
}

export class MeetProvider implements MeetingProviderInterface {
    async parseMeetingUrl(meeting_url: string) {
        return parseMeetingUrlFromJoinInfos(meeting_url)
    }

    getMeetingLink(
        meeting_id: string,
        _password: string,
        _role: number,
        _bot_name: string,
    ) {
        return meeting_id
    }

    async openMeetingPage(
        browserContext: BrowserContext,
        link: string,
        streaming_input: string | undefined,
        attempts: number = 0,
    ): Promise<Page> {
        try {
            console.log('Creating new page in existing context...')
            const page = await browserContext.newPage()

            // Set permissions based on streaming_input
            if (streaming_input) {
                await browserContext.grantPermissions(['microphone', 'camera'])
            } else {
                await browserContext.grantPermissions(['camera'])
            }

            // Enable Web Audio mixing for streaming
            // Check config directly, not Streaming.instance (which may not be instantiated yet)
            if (GLOBAL.get().streaming_output) {
                await enableMeetAudioCapture(page)
                console.log('[Meet] ✅ Web Audio capture enabled for streaming')
            }

            console.log(`Navigating to ${link}...`)
            await page.goto(link, {
                waitUntil: 'networkidle',
                timeout: 30000,
            })
            console.log('Navigation completed')

            // Check for page freeze after goto (same as Teams)
            let pageFrozen = false
            try {
                await Promise.race([
                    page.evaluate(() => document.readyState),
                    new Promise((_, reject) =>
                        setTimeout(
                            () =>
                                reject(
                                    new Error('Page freeze timeout after goto'),
                                ),
                            10000, // 10 seconds timeout to detect freeze
                        ),
                    ),
                ])
            } catch (e) {
                pageFrozen = true
                console.warn(
                    `⚠️ Page appears to be frozen after goto (attempt ${attempts + 1}/3)`,
                )
            }

            // Retry if frozen and we haven't exceeded max attempts
            if (pageFrozen && attempts < 3) {
                await page.close()
                console.log(
                    `🔄 Page freeze detected, retrying... (${attempts + 1}/3)`,
                )
                await sleep(1000) // Wait before retry
                return await this.openMeetingPage(
                    browserContext,
                    link,
                    streaming_input,
                    attempts + 1,
                )
            } else if (pageFrozen && attempts >= 3) {
                console.warn(
                    '⚠️ Page freeze persists after 3 retries, continuing anyway...',
                )
                // Continue - page might recover later
            }

            return page
        } catch (error) {
            console.error('openMeetingPage error:', formatError(error))
            // Mark as retryable - bot hasn't joined yet, so retrying is safe
            // Worst case: 3 attempts (1 initial + 2 retries) before giving up
            console.log('🔄 Error occurred before joining - marking as retryable')
            GLOBAL.setShouldRetry(true)
            throw error
        }
    }

    async joinMeeting(
        page: Page,
        cancelCheck: () => boolean,
        onJoinSuccess: () => void,
        dialogObserver?: SimpleDialogObserver,
    ): Promise<void> {
        try {
            // Capture DOM state before starting join process
            const htmlSnapshot = HtmlSnapshotService.getInstance()
            await htmlSnapshot.captureSnapshot(page, 'meet_join_meeting_start')

            // Bail out early if page already navigated away (e.g. denial during timing wait)
            assertOnMeetPage(page)

            await clickDismiss(page)
            await sleep(300)

            console.log(
                'useWithoutAccountClicked:',
                await clickWithInnerText(
                    page,
                    'span',
                    ['Use without an account'],
                    2,
                ),
            )

            // Hybrid retry strategy: fast path for first 5 attempts, exponential backoff for last 5
            for (let attempt = 1; attempt <= 10; attempt++) {
                if (await typeBotName(page, GLOBAL.get().bot_name)) {
                    console.log('Bot name typed at attempt', attempt)
                    break
                }

                if (attempt < 10) {
                    // Don't wait after last attempt
                    await clickOutsideModal(page)

                    if (attempt < 5) {
                        // Fast path: 500ms fixed delay for attempts 1-4
                        await page.waitForTimeout(500)
                    } else {
                        // Slow path: exponential backoff for attempts 5-9 (handles dialog cases, page temporarily frozen)
                        // Attempt 5: 500ms, attempts 6-9: 1s, 2s, 4s, 8s
                        const exponentialDelay = 1000 * Math.pow(2, attempt - 6)
                        console.log(
                            `Bot name typing failed at attempt ${attempt}, waiting ${exponentialDelay}ms before retry (exponential backoff)`,
                        )
                        await page.waitForTimeout(exponentialDelay)
                    }
                }
            }

            // Control microphone based on streaming_input
            if (GLOBAL.get().streaming_input) {
                await activateMicrophone(page)
            } else {
                await deactivateMicrophone(page)
            }

            // Control camera based on custom_branding_bot_path
            if (GLOBAL.get().custom_branding_bot_path) {
                // Camera will be used for branding, keep it on
                console.log('Camera will be used for branding, keeping it on')
            } else {
                await deactivateCamera(page)
            }

            // Try to click join button - will retry continuously while waiting
            let lastJoinClickAt = 0
            const joinRetryCooldownMs = 2000
            let joinRetryCount = 0

            // Initial attempt to click join button
            const initialClick = await clickJoinCtaIfPresent(page)
            if (initialClick) {
                console.log(
                    'Successfully clicked join button on initial attempt',
                )
                lastJoinClickAt = Date.now()
            } else {
                console.log(
                    'Join button not found on initial attempt, will retry in loop',
                )
            }

            // Wait to be in the meeting with regular cancelCheck verification
            console.log('Waiting to confirm meeting join...')
            let inWaitingRoom = false
            let leftWaitingRoomAt: number | null = null
            while (true) {
                if (cancelCheck()) {
                    GLOBAL.setError(MeetingEndReason.ApiRequest)
                    throw new Error('API request to stop recording')
                }

                // Check if we're in the waiting room
                const nowInWaitingRoom = await isInWaitingRoom(page)
                if (nowInWaitingRoom && !inWaitingRoom) {
                    console.log(
                        '📋 Bot is in waiting room, waiting for host to admit...',
                    )
                    inWaitingRoom = true
                }

                // Detect when we leave the waiting room
                if (inWaitingRoom && !nowInWaitingRoom && !leftWaitingRoomAt) {
                    leftWaitingRoomAt = Date.now()
                    console.log(
                        '✅ Left waiting room, giving UI 2 seconds to fully render...',
                    )
                }

                // Only retry clicking join button if NOT in waiting room
                if (
                    !inWaitingRoom &&
                    Date.now() - lastJoinClickAt >= joinRetryCooldownMs
                ) {
                    const retried = await clickJoinCtaIfPresent(page)
                    if (retried) {
                        lastJoinClickAt = Date.now()
                        joinRetryCount += 1
                        console.log(
                            `Clicked join button (attempt #${joinRetryCount})`,
                        )
                    }
                }

                // After leaving waiting room, give UI time to render before checking
                const gracePeriodExpired =
                    !leftWaitingRoomAt ||
                    Date.now() - leftWaitingRoomAt >= GRACE_PERIOD_MS

                if (gracePeriodExpired) {
                    const inMeeting = await isInMeeting(page)
                    if (inMeeting) {
                        console.log(
                            `✅ Successfully confirmed we are in the meeting (grace period: ${!leftWaitingRoomAt ? 'not in waiting room' : `expired after ${Date.now() - leftWaitingRoomAt}ms`})`,
                        )

                        // Signal join success immediately so the waiting room timeout is cleared.
                        // performCriticalSetupActions can take minutes if dialogs block it.
                        onJoinSuccess()
                        // Critical setup actions BEFORE state transition (People panel, layout, snapshot)
                        await performCriticalSetupActions(page, dialogObserver)
                        break
                    }
                }

                // Check page URL before text-based denial detection — catches redirects
                assertOnMeetPage(page)

                if (await notAcceptedInMeeting(page)) {
                    throw new Error('Bot not accepted into meeting')
                }

                await sleep(1000)
            }

            // OPTIMIZATION: Critical setup actions are now done BEFORE onJoinSuccess()
            // Non-critical actions (entry message, audio verification) moved to InCallState
            // This section is now empty as all actions moved to performCriticalSetupActions()
        } catch (error) {
            console.error('Error in joinMeeting:', formatError(error))
            throw error
        }
    }

    async findEndMeeting(page: Page): Promise<boolean> {
        try {
            try {
                await Promise.race([
                    page.evaluate(() => document.readyState),
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error('Page freeze timeout')),
                            20000,
                        ),
                    ),
                ])
            } catch (e) {
                console.log('Page appears to be frozen for 30 seconds')
                return true
            }

            if (!page.isClosed()) {
                const content = await page.content()
                const endMessages = [
                    "You've been removed",
                    'we encountered a problem joining',
                    'The call ended',
                    'Return to home',
                    'No one else',
                ]

                const foundMessage = endMessages.find((msg) =>
                    content.includes(msg),
                )

                if (foundMessage) {
                    console.log(
                        'End meeting detected through page content:',
                        foundMessage,
                    )
                    return true
                }
            }
            return false
        } catch (error) {
            console.error('Error in findEndMeeting:', error)
            return false
        }
    }

    async closeMeeting(page: Page): Promise<void> {
        await closeMeeting(page)
    }
}

/**
 * Opens People panel using keyboard shortcut (Ctrl+Alt+P)
 * Much faster than finding and clicking the button
 */
async function openPeoplePanelWithShortcut(page: Page): Promise<boolean> {
    try {
        console.log('Opening People panel with keyboard shortcut (Ctrl+Alt+P)...')

        // Press Ctrl+Alt+P to open People panel
        await page.keyboard.press('Control+Alt+KeyP')

        console.log('People panel opened with keyboard shortcut')
        return true
    } catch (error) {
        console.error(
            'Failed to open People panel with shortcut:',
            formatError(error),
        )
        // Fallback to button click if shortcut fails
        console.log('Falling back to button click method...')
        try {
            await findShowEveryOne(page, true, () => false)
        } catch (fallbackError) {
            console.error('Fallback method also failed:', formatError(fallbackError))
        }
        return false // Return false since shortcut failed, fallback attempted
    }
}

async function findShowEveryOne(
    page: Page,
    click: boolean,
    cancelCheck: () => boolean,
) {
    let showEveryOneFound = false
    let i = 0
    let inMeetingConfirmed = false

    while (!showEveryOneFound) {
        try {
            // Check if there's already a global error (bot removed, etc.)
            if (GLOBAL.getEndReason()) {
                console.log('Global error detected, stopping findShowEveryOne')
                return
            }

            // Check if we are actually in the meeting
            inMeetingConfirmed = await isInMeeting(page)
            if (inMeetingConfirmed) {
                console.log('Successfully confirmed we are in the meeting')
            }

            // Search for People button with multiple selectors (OLD + NEW Meet UI)
            const buttons = page.locator(
                [
                    // OLD UI selectors (pre-Dec 2025)
                    'nav button[aria-label="People"][role="button"]',
                    'nav button[aria-label="Show everyone"][role="button"]',
                    'nav button[data-panel-id="1"][role="button"]',
                    // NEW UI selectors (Dec 2025+) - Badge/hover tray style People button
                    'div[role="button"][aria-haspopup="dialog"]:has(span:text("People"))',
                ].join(', '),
            )

            const count = await buttons.count()
            showEveryOneFound = count > 0

            if (showEveryOneFound && click) {
                try {
                    await buttons.first().click()
                    console.log('Successfully clicked People button')

                    // Dismiss the hover dialog (new UI Dec 2025+)
                    // The new badge-style People button shows a hover dialog that needs to be dismissed
                    // Click on the page body to move focus away from the button
                    await page.waitForTimeout(100) // Wait for dialog to appear
                    await page.click('body', {
                        position: { x: 10, y: 10 },
                        force: true,
                    })
                    console.log('Clicked body to dismiss People hover dialog')
                } catch (e) {
                    console.log('Failed to click People button:', e)
                    showEveryOneFound = false
                }
            }

            // If we did not find the button but we are in the meeting,
            // on considère que c'est un succès (certaines réunions n'ont pas ce bouton)
            if (!showEveryOneFound && inMeetingConfirmed) {
                console.log(
                    'Meeting confirmed but People button not found - continuing anyway',
                )
                return
            }

            if (cancelCheck()) {
                GLOBAL.setError(MeetingEndReason.TimeoutWaitingToStart)
                throw new Error('Timeout waiting to start')
            }

            if (await notAcceptedInMeeting(page)) {
                console.log('Bot not accepted, exiting meeting')
                throw new Error('Bot not accepted into meeting')
            }

            if (!showEveryOneFound && !inMeetingConfirmed) {
                await sleep(1000)
            }
            i++
        } catch (error) {
            console.error('Error in findShowEveryOne:', error)
            await sleep(1000)
        }
    }
}

// New function to check if we are actually in the meeting
async function isInMeeting(page: Page): Promise<boolean> {
    try {
        // First check if we have been removed from the meeting (highest priority)
        if (await notAcceptedInMeeting(page)) {
            console.log('Bot has been removed from the meeting')
            return false
        }

        // Check for meeting presence indicators FIRST
        const result = await meetStateDetector.isInMeeting(page)
        const selectorCount =
            MEET_STATE_CONFIG.inMeetingPattern.selectors.length
        const threshold = MEET_STATE_CONFIG.inMeetingPattern.threshold
        console.log(
            `Meeting presence indicators: ${result.count}/${selectorCount} visible (threshold: ${threshold}, matched: ${result.matched})`,
        )

        // If we have strong meeting indicators (threshold met), we're definitely in the meeting
        // This overrides any stale waiting room DOM elements that might still be present
        if (result.matched) {
            console.log(
                `✓ Threshold reached: ${result.count} >= ${threshold} - Confirming in meeting`,
            )
            return true
        }

        // Only if meeting indicators are weak/absent, check if we're in waiting room
        // This prevents false positives from stale waiting room elements after joining
        if (await isInWaitingRoom(page)) {
            console.log(
                `✗ Threshold not met but in waiting room - Not in meeting yet`,
            )
            return false
        }

        // Not enough meeting indicators and not in waiting room
        console.log(
            `✗ Threshold not met and not in waiting room - Not in meeting yet`,
        )
        return false
    } catch (error) {
        console.error('Error checking if in meeting:', error)
        return false
    }
}

// Export for use in InCallState (non-blocking entry message)
// Chat textarea selector (used multiple times in sendEntryMessage)
const CHAT_TEXTAREA_SELECTOR =
    'textarea[placeholder="Send a message"], textarea[aria-label="Send a message to everyone"]'

export async function sendEntryMessage(
    page: Page,
    enterMessage: string,
): Promise<boolean> {
    console.log('Attempting to send entry message...')
    // First check if we are still in the meeting
    const inMeeting = await isInMeeting(page)
    if (!inMeeting) {
        // Additional diagnostic logging to help debug false positives
        const waitingRoom = await isInWaitingRoom(page)
        const denied = await notAcceptedInMeeting(page)
        console.log(
            `Bot is no longer in the meeting, cannot send entry message. Diagnostics: waitingRoom=${waitingRoom}, denied=${denied}`,
        )
        return false
    }

    // truncate the message as meet only allows 516 characters
    enterMessage = enterMessage.substring(0, 500)
    try {
        // OPTIMIZATION: Use keyboard shortcut to open chat (Ctrl+Alt+c)
        // Much faster than finding and clicking the button
        console.log('Opening chat window with keyboard shortcut (Ctrl+Alt+c)...')
        await page.keyboard.press('Control+Alt+KeyC')
        await page.waitForTimeout(200) // Brief wait for chat to open

        // Check if chat opened successfully
        let chatOpened = false
        try {
            await page.waitForSelector(CHAT_TEXTAREA_SELECTOR, {
                state: 'visible',
                timeout: 2000,
            })
            chatOpened = true
        } catch (e) {
            console.log('Chat did not open with shortcut, trying button fallback...')
            // Fallback: Try to find and click chat button using evaluate() to bypass visibility check
            // (HTML cleaner may hide the button, but it's still in the DOM)
            try {
                const chatButton = page.locator(
                    [
                        'button[aria-label*="Chat"]',
                        'button[aria-label*="chat"]',
                        'button[title*="Chat"]',
                        'button[title*="chat"]',
                        'nav button[aria-label="Chat"][role="button"]',
                        'div[role="button"][aria-label*="Chat"]',
                    ].join(', '),
                )
                const count = await chatButton.count()
                if (count > 0) {
                    // Use evaluate() to click directly, bypassing Playwright's visibility check
                    // (HTML cleaner may hide the button, but it's still in the DOM)
                    await chatButton.first().evaluate((el: HTMLElement) => el.click())
                    await page.waitForTimeout(200)
                    await page.waitForSelector(CHAT_TEXTAREA_SELECTOR, {
                        state: 'visible',
                        timeout: ENTRY_MESSAGE_TIMEOUT,
                    })
                    chatOpened = true
                }
            } catch (fallbackError) {
                console.error('Chat button fallback also failed:', formatError(fallbackError))
            }
        }

        if (!chatOpened) {
            console.error('Failed to open chat window')
            return false
        }

        const textarea = page.locator(CHAT_TEXTAREA_SELECTOR)
        await textarea.fill(enterMessage, { timeout: ENTRY_MESSAGE_TIMEOUT })

        const sendButton = page.locator('button:has(i:text("send"))')
        if ((await sendButton.count()) > 0) {
            await sendButton.click({ timeout: ENTRY_MESSAGE_TIMEOUT })
            console.log('Clicked on send button')
            // OPTIMIZATION: Use keyboard shortcut to close chat (Ctrl+Alt+c toggles)
            await page.keyboard.press('Control+Alt+KeyC')
            await page.waitForTimeout(100) // Brief wait for chat to close
            // Open people panel again as chat panel replaces people panel
            await page.keyboard.press('Control+Alt+KeyP')
            return true
        }
        console.log('Send button not found')
        return false
    } catch (error) {
        console.error('Failed to send entry message:', formatError(error))
        return false
    }
}

async function notAcceptedInMeeting(page: Page): Promise<boolean> {
    try {
        const result = await meetStateDetector.isDenied(page)
        if (result.matched && result.matchedText && result.pattern) {
            // Pattern is a DenialPattern
            const denialPattern = result.pattern as any
            console.log(
                `${denialPattern.logPrefix} - Found text: "${result.matchedText}"`,
            )
            GLOBAL.setError(
                denialPattern.reason,
                `${denialPattern.errorMessage} - Found text: "${result.matchedText}"`,
            )

            // NEW: Set retry flag for specific Google Meet anti-bot error
            if (result.matchedText === "You can't join this video call") {
                GLOBAL.setShouldRetry(true)
                console.log(
                    '🔄 Google Meet anti-bot detection - marking for retry',
                )
            }

            return true
        }

        return false
    } catch (error) {
        console.error('Error checking if denied entry:', error)
        return false
    }
}

async function clickDismiss(page: Page): Promise<boolean> {
    try {
        // Handle various transient modals/prompts that appear in the
        // waiting room, including the new "Sign in with your Google account"
        // modal whose primary action button text is "Got it".
        //
        // Note: SimpleDialogObserver also handles these, but this serves as a fallback
        // during the initial join flow before the observer is fully active.
        const dismissTexts = ['Dismiss', 'Got it']

        for (const text of dismissTexts) {
            const button = page
                .locator('button, div[role=button], span[role=button]')
                .filter({ hasText: text })
                .first()

            if ((await button.count()) === 0) {
                continue
            }

            const isVisible = await button.isVisible().catch(() => false)
            const isEnabled = await button.isEnabled().catch(() => false)

            if (isVisible && isEnabled) {
                await button.click()
                return true
            }
        }
        return false
    } catch (e) {
        console.error('[joinMeeting] meet find dismiss', e)
        return false
    }
}

async function clickWithInnerText(
    page: Page,
    selector: string,
    texts: string[],
    maxAttempts: number,
    shouldClick: boolean = true,
): Promise<boolean> {
    console.log(
        `Attempting to find ${selector} with texts: ${texts.join(', ')}`,
    )

    // First, take a screenshot to see what the page looks like
    for (let i = 0; i < maxAttempts; i++) {
        try {
            if (i === 0) {
                // Log visible buttons for debugging
                const visibleButtons = await page.evaluate(() => {
                    return Array.from(
                        document.querySelectorAll(
                            'button, span[role="button"]',
                        ),
                    )
                        .filter((el) => {
                            const style = window.getComputedStyle(el)
                            return (
                                style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                style.opacity !== '0'
                            )
                        })
                        .map((el) => ({
                            text: el.textContent?.trim(),
                            role: el.getAttribute('role'),
                            ariaLabel: el.getAttribute('aria-label'),
                        }))
                })
                console.log(
                    'Visible buttons:',
                    JSON.stringify(visibleButtons, null, 2),
                )
            }

            for (const text of texts) {
                console.log(
                    `Attempt ${i + 1}/${maxAttempts} - Looking for "${text}" in ${selector}`,
                )

                // Try multiple selector strategies
                const selectors = [
                    `${selector}:has-text("${text}")`,
                    `${selector}:text-is("${text}")`,
                    `${selector}[aria-label*="${text}"]`,
                    `button:has(${selector}:has-text("${text}"))`,
                ]

                for (const sel of selectors) {
                    const element = page.locator(sel)
                    const count = await element.count()
                    console.log(`  - Selector "${sel}" found ${count} elements`)

                    if (count > 0) {
                        console.log(
                            `  - Found element with text "${text}" using selector "${sel}"`,
                        )
                        if (shouldClick) {
                            await element.click()
                            console.log(
                                `  - Clicked on element with text "${text}"`,
                            )
                        }
                        return true
                    }
                }
            }
        } catch (e) {
            console.error(
                `Error in clickWithInnerText (attempt ${i + 1}/${maxAttempts}):`,
                e,
            )
        }
        await page.waitForTimeout(100 + i * 100)
    }

    // Log all visible text on the page as a last resort
    console.log(
        'All visible text on page:',
        await page.evaluate(() => {
            return document.body.innerText.slice(0, 1000) + '...'
        }),
    )

    return false
}

/**
 * Generic function to check page indicators
 * Returns the count of found indicators
 */
async function checkIndicators(
    page: Page,
    selectors: string[],
    checkPresenceOnly: boolean = false,
): Promise<number> {
    let foundCount = 0
    for (const selector of selectors) {
        try {
            const count = await page
                .locator(selector)
                .count()
                .catch(() => 0)
            if (count > 0) {
                if (checkPresenceOnly) {
                    // Just check presence in DOM, not visibility
                    // Useful when menus/modals might hide elements
                    foundCount++
                } else {
                    const isVisible = await page
                        .locator(selector)
                        .first()
                        .isVisible()
                        .catch(() => false)
                    if (isVisible) {
                        foundCount++
                    }
                }
            }
        } catch (e) {
            // Continue checking other indicators
        }
    }
    return foundCount
}

/**
 * Checks if the bot is in the waiting room (waiting to be admitted)
 */
async function isInWaitingRoom(page: Page): Promise<boolean> {
    try {
        const result = await meetStateDetector.isWaitingRoom(page)
        if (result.matched) {
            console.log(
                `Waiting room detected: ${result.count} indicators found`,
            )
            return true
        }
        return false
    } catch (error) {
        return false
    }
}

async function clickJoinCtaIfPresent(page: Page): Promise<boolean> {
    // Try multiple selector strategies to find join button
    const joinSelectors = [
        // Text-based selectors
        'button:has-text("Ask to join")',
        'span:has-text("Ask to join")',
        'button:has-text("Join now")',
        'span:has-text("Join now")',
        'button:has-text("Join meeting")',
        'span:has-text("Join meeting")',
        'button:has-text("Join")',
        'span:has-text("Join")',
        'button:has-text("Enter meeting")',
        'span:has-text("Enter meeting")',
        // Aria-label based selectors (more stable)
        'button[aria-label*="Join"]',
        'button[aria-label*="join now"]',
        'button[aria-label*="Ask to join"]',
    ]

    try {
        // Press Escape first to close any modal that might be blocking
        await page.keyboard.press('Escape')
        await page.waitForTimeout(100)

        for (const selector of joinSelectors) {
            try {
                const locator = page.locator(selector).first()
                const count = await locator.count()
                if (count === 0) {
                    continue
                }

                const isVisible = await locator.isVisible().catch(() => false)
                const isEnabled = await locator.isEnabled().catch(() => false)

                if (isVisible && isEnabled) {
                    await locator.click({ timeout: 2000 })
                    console.log(
                        `Successfully clicked join button using selector: ${selector}`,
                    )
                    return true
                }
            } catch (e) {
                // Continue to next selector if this one fails
                continue
            }
        }
    } catch (error) {
        console.error('Failed to click join CTA:', error)
    }
    return false
}

/**
 * OPTIMIZED: Performs critical setup actions before state transition
 * - Opens People panel (keyboard shortcut)
 * - Changes layout to Spotlight (optimized)
 * - Captures HTML snapshot
 */
async function performCriticalSetupActions(
    page: Page,
    dialogObserver?: SimpleDialogObserver,
): Promise<void> {
    const htmlSnapshot = HtmlSnapshotService.getInstance()

    // 1. Open People Panel FIRST (keyboard shortcut - fastest)
    if (GLOBAL.get().recording_mode !== 'gallery_view') {
        await openPeoplePanelWithShortcut(page)
    }

    // 2. Change Layout to Spotlight (optimized)
    if (GLOBAL.get().recording_mode !== 'audio_only') {
        // Pause the dialog observer while we interact with the layout dialog.
        // The observer would detect the Change Layout dialog as generic_dismiss
        // and race with our Playwright interactions, causing timeouts.
        SimpleDialogObserver.pause()
        try {
            const maxAttempts = 3
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                // Manually dismiss any visible dialogs before attempting layout change.
                // The observer is paused so it can't do this automatically — but dialogs
                // like "Other people may see your video differently" block the More Options
                // button with a scrim overlay.
                if (dialogObserver) {
                    await dialogObserver.dismissVisibleDialogs()
                }
                if (await changeLayout(page, attempt)) {
                    console.log(`Layout change successful on attempt ${attempt}`)
                    break
                }
                if (attempt < maxAttempts) {
                    await clickOutsideModal(page)
                    await page.waitForTimeout(300)
                }
            }
        } finally {
            SimpleDialogObserver.resume()
        }
    }

    // 3. HTML snapshot (quick, non-blocking)
    void htmlSnapshot.captureSnapshot(page, 'meet_join_meeting_success')
}

async function changeLayout(
    page: Page,
    currentAttempt = 1,
    maxAttempts = 3,
): Promise<boolean> {
    console.log(
        `Starting layout change process (attempt ${currentAttempt}/${maxAttempts})...`,
    )

    try {
        // OPTIMIZATION: Check isInMeeting() ONCE at the start only
        const inMeeting = await isInMeeting(page)
        if (!inMeeting) {
            console.log(
                'Bot is no longer in the meeting, stopping layout change',
            )
            GLOBAL.setError(
                MeetingEndReason.BotRemoved,
                'Bot removed during layout change',
            )
            return false
        }

        // OPTIMIZATION: Remove networkidle wait (unnecessary for UI clicks)
        // await page.waitForLoadState('networkidle', { timeout: 5000 })  // REMOVED

        // 1. Click More options button
        console.log('Looking for More options button in call controls...')
        const moreOptionsButton = page.locator(
            'div[role="region"][aria-label="Call controls"] button[aria-label="More options"]',
        )
        await moreOptionsButton.waitFor({ state: 'visible', timeout: 3000 })
        await moreOptionsButton.click()

        // OPTIMIZATION: Wait for menu to appear instead of fixed timeout
        await page.waitForSelector('[role="menu"]', {
            state: 'visible',
            timeout: 1000,
        })
        // await page.waitForTimeout(500)  // REMOVED

        // OPTIMIZATION: Remove redundant isInMeeting check
        // if (!(await isInMeeting(page))) { ... }  // REMOVED

        // 2. Click Change layout menu item
        console.log('Looking for Change layout/Adjust view menu item...')
        const changeLayoutItem = page.locator(
            '[role="menu"] [role="menuitem"]:has(span:has-text("Change layout"), span:has-text("Adjust view"))',
        )
        await changeLayoutItem.waitFor({ state: 'visible', timeout: 3000 })
        await changeLayoutItem.click()

        // OPTIMIZATION: Wait for layout menu to appear instead of fixed timeout
        await page.waitForSelector('label:has-text("Spotlight")', {
            state: 'visible',
            timeout: 1000,
        })
        // await page.waitForTimeout(500)  // REMOVED

        // OPTIMIZATION: Remove redundant isInMeeting check
        // if (!(await isInMeeting(page))) { ... }  // REMOVED

        // 3. Click Spotlight option
        console.log('Looking for Spotlight option...')
        const spotlightOption = page
            .locator(
                [
                    'label:has-text("Spotlight"):has(input[type="radio"])',
                    'label:has(input[name="preferences"]):has-text("Spotlight")',
                    'label:has(span:text-is("Spotlight"))',
                ].join(','),
            )
            .first() // Use first() to handle cases where multiple Spotlight labels exist
        await spotlightOption.waitFor({ state: 'visible', timeout: 3000 })
        await spotlightOption.click()

        // OPTIMIZATION: Wait for layout to change instead of fixed timeout
        await page.waitForTimeout(300) // Reduced from 500ms
        // OPTIMIZATION: Remove redundant isInMeeting check
        // if (!(await isInMeeting(page))) { ... }  // REMOVED

        await clickOutsideModal(page)
        return true
    } catch (error) {
        console.error(
            `Error in changeLayout attempt ${currentAttempt}:`,
            formatError(error),
        )

        if (currentAttempt < maxAttempts) {
            console.log(
                `Retrying layout change (attempt ${currentAttempt + 1}/${maxAttempts})...`,
            )
            await page.waitForTimeout(1000)
            return changeLayout(page, currentAttempt + 1, maxAttempts)
        }
        return false
    }
}

async function clickOutsideModal(page: Page) {
    await sleep(500)
    await page.mouse.click(10, 10)
    await sleep(10)
    await page.mouse.click(10, 10)
    await sleep(10)
    await page.mouse.click(10, 10)
}

async function typeBotName(page: Page, botName: string): Promise<boolean> {
    const INPUT = 'input[type=text]'
    const BotNameTyped = botName || 'Bot'

    try {
        await page.waitForSelector(INPUT, { timeout: 1000 })

        // Effacer le champ de texte existant
        await page.fill(INPUT, '')

        // Taper le nouveau nom
        await page.fill(INPUT, BotNameTyped)

        // Check that the text has been properly entered
        const inputValue = await page.inputValue(INPUT)
        return inputValue.includes(BotNameTyped)
    } catch (e) {
        console.error('error in typeBotName', e)
        return false
    }
}

async function activateMicrophone(page: Page): Promise<boolean> {
    console.log('Activating microphone...')
    try {
        // Look for the microphone button that's turned off
        const microphoneButton = page.locator(
            'div[aria-label="Turn on microphone"]',
        )
        if ((await microphoneButton.count()) > 0) {
            await microphoneButton.click()
            console.log('Microphone activated successfully')
            return true
        } else {
            console.log('Microphone is already active or button not found')
            return false
        }
    } catch (error) {
        console.error('Error activating microphone:', error)
        return false
    }
}

async function deactivateMicrophone(page: Page): Promise<boolean> {
    console.log('Deactivating microphone...')
    try {
        // Look for the microphone button that's turned on
        const microphoneButton = page.locator(
            'div[aria-label="Turn off microphone"]',
        )
        if ((await microphoneButton.count()) > 0) {
            await microphoneButton.click()
            console.log('Microphone deactivated successfully')
            return true
        } else {
            console.log('Microphone is already deactivated or button not found')
            return false
        }
    } catch (error) {
        console.error('Error deactivating microphone:', error)
        return false
    }
}

async function deactivateCamera(page: Page): Promise<boolean> {
    console.log('Deactivating camera...')
    try {
        // Look for the camera button that's turned on
        const cameraButton = page.locator(
            'div[aria-label="Turn off camera"]',
        )
        if ((await cameraButton.count()) > 0) {
            await cameraButton.click()
            console.log('Camera deactivated successfully')
            return true
        } else {
            console.log('Camera is already deactivated or button not found')
            return false
        }
    } catch (error) {
        console.error('Error deactivating camera:', error)
        return false
    }
}
// async function MuteMicrophone(page: Page) {
//     try {
//         await page.evaluate(() => {
//             const tryClickMicrophone = () => {
//                 const microphoneButtons = Array.from(
//                     document.querySelectorAll('div'),
//                 ).filter(
//                     (el) =>
//                         el.getAttribute('aria-label') &&
//                         el
//                             .getAttribute('aria-label')
//                             .includes('Turn off microphone'),
//                 )

//                 if (microphoneButtons.length > 0) {
//                     microphoneButtons.forEach((button) => button.click())
//                     console.log(
//                         `${microphoneButtons.length} microphone button(s) turned off.`,
//                     )
//                 } else {
//                     console.log('No microphone button found. Retrying...')
//                     setTimeout(tryClickMicrophone, 1000)
//                 }
//             }

//             tryClickMicrophone()
//         })
//     } catch (e) {
//         console.error('Error when trying to turn off the microphone:', e)
//     }
// }
