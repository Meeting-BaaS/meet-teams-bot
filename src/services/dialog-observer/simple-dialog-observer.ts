import type { Locator, Page } from '@playwright/test'
import { GLOBAL } from '../../singleton'
import { MeetingContext } from '../../state-machine/types'
import { HtmlSnapshotService } from '../html-snapshot-service'
import { DialogObserverResult } from './types'

interface DismissTimeouts {
    VISIBLE_TIMEOUT: number
    CLICK_TIMEOUT: number
    PAGE_TIMEOUT: number
}

const TIMEOUTS: DismissTimeouts = {
    VISIBLE_TIMEOUT: 500,
    CLICK_TIMEOUT: 1000,
    PAGE_TIMEOUT: 2000,
}

/**
 * Simplified dialog observer specifically for Google Meet
 * Focuses on common Google Meet modal patterns
 */
export class SimpleDialogObserver {
    protected context: MeetingContext
    protected dialogObserverInterval?: NodeJS.Timeout

    /**
     * Static flag to temporarily pause the observer (e.g. during layout change)
     * so it doesn't race with intentional Playwright interactions on dialogs we opened.
     */
    private static _paused = false

    /**
     * Instance flag to prevent overlapping observer cycles.
     * setInterval fires every 2s regardless of whether the previous async cycle
     * has completed. Without this guard, multiple cycles run concurrently and
     * contend for the Playwright CDP connection, causing timeouts.
     */
    private isRunning = false

    static pause() {
        SimpleDialogObserver._paused = true
        console.info('[SimpleDialogObserver] Observer paused')
    }

    static resume() {
        SimpleDialogObserver._paused = false
        console.info('[SimpleDialogObserver] Observer resumed')
    }

    /**
     * Manually trigger a single dialog check-and-dismiss cycle.
     * Should be called while the observer is paused (via SimpleDialogObserver.pause())
     * to avoid racing with the periodic observer cycle.
     * Works even when the observer is paused — useful for clearing unexpected
     * dialogs before intentional UI interactions (e.g. layout change).
     */
    async dismissVisibleDialogs(): Promise<DialogObserverResult> {
        if (!this.context.playwrightPage || this.context.playwrightPage.isClosed()) {
            return { found: false, dismissed: false, modalType: null }
        }

        try {
            const result = await this.checkAndDismissModals(this.context.playwrightPage)
            if (result.found) {
                console.info(
                    `[SimpleDialogObserver] Manual dismiss: ${result.modalType} - ${result.dismissed ? 'dismissed' : 'found but not dismissed'}`,
                )
            }
            return result
        } catch (error) {
            console.error(`[SimpleDialogObserver] Error in manual dismiss: ${error}`)
            return { found: false, dismissed: false, modalType: null }
        }
    }

    constructor(context: MeetingContext) {
        this.context = context
    }

    setupGlobalDialogObserver() {
        // Only start observer for Google Meet
        if (GLOBAL.get().meetingProvider !== 'Meet') {
            console.info(
                `[SimpleDialogObserver] Observer not started: provider is not Google Meet (${GLOBAL.get().meetingProvider})`,
            )
            return
        }

        this.stopGlobalDialogObserver()
        this.startGlobalDialogObserver()
    }

    stopGlobalDialogObserver() {
        if (this.dialogObserverInterval) {
            clearInterval(this.dialogObserverInterval)
            this.dialogObserverInterval = undefined
            console.info(`[SimpleDialogObserver] Stopped dialog observer`)
        }
    }

    protected startGlobalDialogObserver() {
        console.info(`[SimpleDialogObserver] Starting dialog observer`)
        // Check every 2 seconds for faster modal dismissal during join
        this.dialogObserverInterval = setInterval(this.observer, 2000)
    }

    protected observer = async (): Promise<void> => {
        if (SimpleDialogObserver._paused) {
            return
        }

        // Guard: skip if previous cycle is still running to prevent
        // concurrent Playwright operations from contending on the CDP connection.
        if (this.isRunning) {
            return
        }
        this.isRunning = true

        try {
            if (!this.context.playwrightPage) {
                console.warn(
                    '[SimpleDialogObserver] Cannot start observer: page not available',
                )
                return
            }

            // Check if page is still open before proceeding
            if (this.context.playwrightPage?.isClosed()) {
                console.info(
                    `[SimpleDialogObserver] Page closed, stopping observer`,
                )
                this.stopGlobalDialogObserver()
                return
            }

            const result = await this.checkAndDismissModals(
                this.context.playwrightPage,
            )

            if (result.found) {
                console.info(
                    `[SimpleDialogObserver] Modal result: ${result.modalType} - ${result.dismissed ? 'dismissed' : 'found but not dismissed'}`,
                )
            }
        } catch (error) {
            // If page is closed, stop the observer
            if (
                error instanceof Error &&
                error.message.includes(
                    'Target page, context or browser has been closed',
                )
            ) {
                console.info(
                    `[SimpleDialogObserver] Page closed during observer execution, stopping`,
                )
                this.stopGlobalDialogObserver()
                return
            }
            console.error(
                `[SimpleDialogObserver] Error checking dialogs: ${error}`,
            )
        } finally {
            this.isRunning = false
        }
    }

    /**
     * Simplified modal detection focusing on Google Meet's common patterns
     */
    protected async checkAndDismissModals(
        page: Page,
        customTimeout: number = 0,
    ): Promise<DialogObserverResult> {
        const timeouts =
            customTimeout === 0
                ? TIMEOUTS
                : {
                      VISIBLE_TIMEOUT: customTimeout,
                      CLICK_TIMEOUT: customTimeout,
                      PAGE_TIMEOUT: customTimeout,
                  }

        try {
            // Google Meet specific modal patterns
            // IMPORTANT: Order matters! More specific patterns must come before generic ones
            // to avoid misidentification (e.g., transcription modal matching camera_permission)
            const modalPatterns = [
                // People hover dialog (new UI Dec 2025) - dismiss with Escape
                {
                    name: 'people_hover_dialog',
                    selector:
                        'div[role="dialog"][aria-label*="people in the call" i]:has-text("People")',
                    buttonTexts: [], // No buttons to click, just dismiss with Escape
                    exitByEscape: true,
                },
                // Recording/transcription modals - MUST come first (they may contain "camera"/"microphone" text)
                {
                    name: 'recording_notification',
                    selector:
                        'div[role="dialog"]:has-text("video call is being recorded"):has(button)',
                    buttonTexts: ['Join now'],
                    exitByEscape: false,
                },
                {
                    name: 'transcribe_notification',
                    selector:
                        'div[role="dialog"]:has-text("video call is being transcribed"):has(button)',
                    buttonTexts: ['Join now'],
                    exitByEscape: false,
                },
                // Gemini/notes modal
                {
                    name: 'gemini_notification',
                    selector:
                        'div[role="dialog"]:has-text("Gemini"):has-text("taking notes"):has(button)',
                    buttonTexts: ['Join now'],
                    exitByEscape: false,
                },
                // Privacy/notification modals
                {
                    name: 'privacy_notification',
                    selector:
                        'div[role="dialog"]:has-text("Others may see"):has(button)',
                    buttonTexts: ['Got it', 'OK', 'Dismiss', 'Close'],
                    exitByEscape: false,
                },
                // Video privacy modals
                {
                    name: 'video_privacy',
                    selector:
                        'div[role="dialog"]:has-text("video differently"):has(button)',
                    buttonTexts: ['Got it', 'OK', 'Continue'],
                    exitByEscape: false,
                },
                // Background/feed modals
                {
                    name: 'background_feed',
                    selector:
                        'div[role="dialog"]:has-text("background"):has(button), div[role="dialog"]:has-text("feed"):has(button)',
                    buttonTexts: ['Got it', 'OK', 'Dismiss'],
                    exitByEscape: false,
                },
                // Camera/microphone permission modals - after specific modals to avoid false positives
                // These can be dismissed with Escape key if buttons are not found
                {
                    name: 'camera_permission',
                    selector:
                        'div[role="dialog"]:has-text("camera"):has(button), div[role="dialog"]:has-text("microphone"):has(button)',
                    buttonTexts: ['Allow', 'Block', 'Got it', 'OK', 'Join now'],
                    exitByEscape: true,
                },
                // Generic dismiss modals (fallback)
                {
                    name: 'generic_dismiss',
                    selector: 'div[role="dialog"]:has(button)',
                    buttonTexts: [
                        'Join now',
                        'Got it',
                        'OK',
                        'Dismiss',
                        'Close',
                        'Continue',
                    ],
                    exitByEscape: false,
                },
            ]

            for (const pattern of modalPatterns) {
                try {
                    const modal = page.locator(pattern.selector)
                    const isVisible = await modal.isVisible({
                        timeout: timeouts.VISIBLE_TIMEOUT,
                    })

                    if (!isVisible) {
                        continue
                    }

                    console.info(
                        `[SimpleDialogObserver] Found modal: ${pattern.name}`,
                    )

                    // Capture DOM state before attempting to dismiss modal
                    const htmlSnapshot = HtmlSnapshotService.getInstance()
                    await htmlSnapshot.captureSnapshot(
                        page,
                        `dialog_observer_before_dismiss_attempt_${pattern.name}`,
                    )

                    // Try to dismiss the modal by clicking appropriate buttons
                    let dismissed = await this.tryDismissModal(
                        modal,
                        pattern.buttonTexts,
                        timeouts,
                    )

                    // If button click didn't work and exitByEscape is enabled, try Escape key
                    if (!dismissed && pattern.exitByEscape) {
                        console.info(
                            `[SimpleDialogObserver] Button click failed for ${pattern.name}, trying Escape key`,
                        )
                        dismissed = await this.tryDismissWithEscape(page)
                    }

                    if (dismissed) {
                        await page.waitForTimeout(timeouts.PAGE_TIMEOUT)
                        return {
                            found: true,
                            dismissed: true,
                            modalType: pattern.name,
                            detectionMethod: 'simple_google_meet',
                        }
                    }

                    return {
                        found: true,
                        dismissed: false,
                        modalType: pattern.name,
                        detectionMethod: 'simple_google_meet',
                    }
                } catch (error) {
                    console.warn(
                        `[SimpleDialogObserver] Error with pattern ${pattern.name}: ${error}`,
                    )
                }
            }

            return { found: false, dismissed: false, modalType: null }
        } catch (error) {
            console.error(
                '[SimpleDialogObserver] Error during modal detection:',
                error,
            )
            return {
                found: false,
                dismissed: false,
                modalType: 'detection_error',
            }
        }
    }

    /**
     * Try to dismiss a modal by pressing the Escape key
     */
    private async tryDismissWithEscape(page: Page): Promise<boolean> {
        try {
            await page.keyboard.press('Escape')
            console.info(
                '[SimpleDialogObserver] Pressed Escape key to dismiss modal',
            )
            return true
        } catch (error) {
            console.warn(
                `[SimpleDialogObserver] Error pressing Escape key: ${error}`,
            )
            return false
        }
    }

    /**
     * Try to dismiss a modal by clicking appropriate buttons within the modal.
     * Uses locator-based finding (same as before) but clicks via evaluate()
     * (direct DOM click) instead of Playwright's coordinate-based click.
     * This bypasses actionability checks so it works even when the button
     * is behind the video overlay or hidden by the HTML cleaner.
     */
    private async tryDismissModal(
        modal: Locator,
        buttonTexts: string[],
        timeouts: DismissTimeouts,
    ): Promise<boolean> {
        // Only search within the modal, not the entire page
        for (const buttonText of buttonTexts) {
            try {
                // Try exact text match first
                let button = modal.locator(`button:has-text("${buttonText}")`)
                let buttonCount = await button.count()

                if (
                    buttonCount > 0 &&
                    (await button
                        .first()
                        .isVisible({ timeout: timeouts.VISIBLE_TIMEOUT }))
                ) {
                    console.info(
                        `[SimpleDialogObserver] Clicking button: "${buttonText}"`,
                    )
                    await button
                        .first()
                        .evaluate((el: HTMLElement) => el.click(), { timeout: timeouts.CLICK_TIMEOUT })
                    return true
                }

                // Try partial text match
                button = modal.locator(
                    `button:text-matches(".*${buttonText}.*", "i")`,
                )
                buttonCount = await button.count()

                if (
                    buttonCount > 0 &&
                    (await button
                        .first()
                        .isVisible({ timeout: timeouts.VISIBLE_TIMEOUT }))
                ) {
                    console.info(
                        `[SimpleDialogObserver] Clicking button (partial match): "${buttonText}"`,
                    )
                    await button
                        .first()
                        .evaluate((el: HTMLElement) => el.click(), { timeout: timeouts.CLICK_TIMEOUT })
                    return true
                }

                // Try span content (for Material Design buttons)
                button = modal.locator(
                    `button span:has-text("${buttonText}")`,
                )
                buttonCount = await button.count()

                if (
                    buttonCount > 0 &&
                    (await button
                        .first()
                        .isVisible({ timeout: timeouts.VISIBLE_TIMEOUT }))
                ) {
                    console.info(
                        `[SimpleDialogObserver] Clicking button (span): "${buttonText}"`,
                    )
                    // Navigate to parent button element and click via evaluate
                    const parentButton = button.first().locator('xpath=..')
                    await parentButton.evaluate((el: HTMLElement) => el.click(), { timeout: timeouts.CLICK_TIMEOUT })
                    return true
                }
            } catch (error) {
                console.warn(
                    `[SimpleDialogObserver] Error trying button "${buttonText}": ${error}`,
                )
            }
        }

        return false
    }
}
