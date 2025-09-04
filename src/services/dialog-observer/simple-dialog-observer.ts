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
        // Check every 5 seconds
        this.dialogObserverInterval = setInterval(this.observer, 5000)
    }

    protected observer = async (): Promise<void> => {
        if (!this.context.playwrightPage) {
            console.warn(
                '[SimpleDialogObserver] Cannot start observer: page not available',
            )
            return
        }

        try {
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
            const modalPatterns = [
                // Transcription/notes modal
                {
                    name: 'gemini_notification',
                    selector:
                        'div[role="dialog"]:has-text("Gemini"):has-text("taking notes"):has(button)',
                    buttonTexts: ['Join now'],
                },
                // Privacy/notification modals
                {
                    name: 'privacy_notification',
                    selector:
                        'div[role="dialog"]:has-text("Others may see"):has(button)',
                    buttonTexts: ['Got it', 'OK', 'Dismiss', 'Close'],
                },
                // Camera/microphone permission modals
                {
                    name: 'camera_permission',
                    selector:
                        'div[role="dialog"]:has-text("camera"):has(button), div[role="dialog"]:has-text("microphone"):has(button)',
                    buttonTexts: ['Allow', 'Block', 'Got it', 'OK'],
                },
                // Video privacy modals
                {
                    name: 'video_privacy',
                    selector:
                        'div[role="dialog"]:has-text("video differently"):has(button)',
                    buttonTexts: ['Got it', 'OK', 'Continue'],
                },
                // Background/feed modals
                {
                    name: 'background_feed',
                    selector:
                        'div[role="dialog"]:has-text("background"):has(button), div[role="dialog"]:has-text("feed"):has(button)',
                    buttonTexts: ['Got it', 'OK', 'Dismiss'],
                },
                // Recording notification modal
                {
                    name: 'recording_notification',
                    selector:
                        'div[role="dialog"]:has-text("video call is being recorded"):has(button)',
                    buttonTexts: ['Join now'],
                },
                // Generic dismiss modals (fallback)
                {
                    name: 'generic_dismiss',
                    selector: 'div[role="dialog"]:has(button)',
                    buttonTexts: [
                        'Got it',
                        'OK',
                        'Dismiss',
                        'Close',
                        'Continue',
                    ],
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
                    const dismissed = await this.tryDismissModal(
                        modal,
                        pattern.buttonTexts,
                        timeouts,
                    )

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
     * Try to dismiss a modal by clicking appropriate buttons within the modal
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
                        .click({ timeout: timeouts.CLICK_TIMEOUT })
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
                        .click({ timeout: timeouts.CLICK_TIMEOUT })
                    return true
                }

                // Try span content (for Material Design buttons)
                button = modal.locator(`button span:has-text("${buttonText}")`)
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
                    await button
                        .first()
                        .click({ timeout: timeouts.CLICK_TIMEOUT })
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
