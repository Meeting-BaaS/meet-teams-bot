import { BrowserContext, Page } from '@playwright/test'

import { MeetingEndReason } from '../state-machine/types'
import { MeetingProviderInterface } from '../types'

import { HtmlSnapshotService } from '../services/html-snapshot-service'
import { GLOBAL } from '../singleton'
import { parseMeetingUrlFromJoinInfos } from '../urlParser/meetUrlParser'
import { sleep } from '../utils/sleep'
import { closeMeeting } from './meet/closeMeeting'

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

            console.log(`Navigating to ${link}...`)
            await page.goto(link, {
                waitUntil: 'networkidle',
                timeout: 30000,
            })
            console.log('Navigation completed')

            return page
        } catch (error) {
            console.error('openMeetingPage error:', {
                message: (error as Error).message,
                stack: (error as Error).stack,
                name: (error as Error).name,
            })
            throw error
        }
    }

    async joinMeeting(
        page: Page,
        cancelCheck: () => boolean,
        onJoinSuccess: () => void,
    ): Promise<void> {
        try {
            // Capture DOM state before starting join process
            const htmlSnapshot = HtmlSnapshotService.getInstance()
            await htmlSnapshot.captureSnapshot(page, 'meet_join_meeting_start')

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

            for (let attempt = 1; attempt <= 5; attempt++) {
                if (await typeBotName(page, GLOBAL.get().bot_name)) {
                    console.log('Bot name typed at attempt', attempt)
                    break
                }
                await clickOutsideModal(page)
                await page.waitForTimeout(500)
            }

            // Control microphone based on streaming_input
            if (GLOBAL.get().streaming_input) {
                await activateMicrophone(page)
            } else {
                await deactivateMicrophone(page)
            }

            // Try multiple approaches to find the join button
            let askToJoinClicked = false
            const joinButtonMaxAttempts = 5

            // Alternating between span and button selectors for 5 iterations total
            for (let attempt = 1; attempt <= joinButtonMaxAttempts; attempt++) {
                console.log(
                    `Join button search attempt ${attempt}/${joinButtonMaxAttempts}`,
                )

                // First try with span selector (odd attempts)
                if (!askToJoinClicked && attempt % 2 === 1) {
                    askToJoinClicked = await clickWithInnerText(
                        page,
                        'span',
                        ['Ask to join', 'Join now'],
                        1, // Only try once per iteration
                    )
                    if (askToJoinClicked) {
                        console.log(
                            `Found join button in span element on attempt ${attempt}`,
                        )
                        break
                    }
                }

                // Then try with button selector (even attempts or after span failed)
                if (!askToJoinClicked) {
                    askToJoinClicked = await clickWithInnerText(
                        page,
                        'button',
                        [
                            'Ask to join',
                            'Join now',
                            'Join meeting',
                            'Join',
                            'Enter meeting',
                        ],
                        1, // Only try once per iteration
                    )
                    if (askToJoinClicked) {
                        console.log(
                            `Found join button in button element on attempt ${attempt}`,
                        )
                        break
                    }
                }

                // Short pause between attempts
                if (!askToJoinClicked && attempt < joinButtonMaxAttempts) {
                    await page.waitForTimeout(100)
                }
            }

            if (!askToJoinClicked) {
                console.log(
                    'All attempts with alternating selectors failed, trying by aria-label',
                )

                // Try by aria-label which might be more stable
                try {
                    const joinButtons = page.locator(
                        'button[aria-label*="Join"], button[aria-label*="join now"]',
                    )
                    const count = await joinButtons.count()
                    console.log(
                        `Found ${count} buttons with Join in aria-label`,
                    )

                    if (count > 0) {
                        await joinButtons.first().click()
                        console.log('Clicked join button by aria-label')
                        askToJoinClicked = true
                    }
                } catch (e) {
                    console.error('Error trying to click by aria-label:', e)
                }
            }

            if (!askToJoinClicked) {
                GLOBAL.setError(MeetingEndReason.CannotJoinMeeting)
                throw new Error('Cannot join meeting')
            }

            // Wait to be in the meeting with regular cancelCheck verification
            console.log('Waiting to confirm meeting join...')
            while (true) {
                if (cancelCheck()) {
                    GLOBAL.setError(MeetingEndReason.ApiRequest)
                    throw new Error('API request to stop recording')
                }

                if (await isInMeeting(page)) {
                    console.log('Successfully confirmed we are in the meeting')
                    onJoinSuccess()
                    break
                }

                if (await notAcceptedInMeeting(page)) {
                    throw new Error('Bot not accepted into meeting')
                }

                await sleep(1000)
            }

            // Once in the meeting, execute all post-join actions
            // WITHOUT checking cancelCheck since we are already in the meeting

            // Capture DOM state after successfully joining meeting
            await htmlSnapshot.captureSnapshot(
                page,
                'meet_join_meeting_success',
            )

            if (GLOBAL.get().enter_message) {
                console.log('Sending entry message...')
                await sendEntryMessage(page, GLOBAL.get().enter_message)
                await sleep(100)
            }

            await clickOutsideModal(page)
            const maxAttempts = 3
            if (GLOBAL.get().recording_mode !== 'audio_only') {
                // Capture DOM state before layout change attempts
                await htmlSnapshot.captureSnapshot(
                    page,
                    'meet_layout_change_before_attempts',
                )

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    if (await changeLayout(page, attempt)) {
                        console.log(
                            `Layout change successful on attempt ${attempt}`,
                        )
                        break
                    }
                    console.log(`Attempt ${attempt} failed`)
                    await clickOutsideModal(page)
                    await page.waitForTimeout(500)
                }
            }

            if (GLOBAL.get().recording_mode !== 'gallery_view') {
                // Capture DOM state before opening people panel
                await htmlSnapshot.captureSnapshot(
                    page,
                    'meet_people_panel_before_open',
                )

                await findShowEveryOne(page, true, cancelCheck)
            }
        } catch (error) {
            console.error('Error in joinMeeting:', {
                message: (error as Error).message,
                stack: (error as Error).stack,
            })
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
            // Check if we are actually in the meeting
            inMeetingConfirmed = await isInMeeting(page)
            if (inMeetingConfirmed) {
                console.log('Successfully confirmed we are in the meeting')
            }

            // Chercher le bouton People comme avant
            const buttons = page.locator(
                [
                    'nav button[aria-label="People"][role="button"]',
                    'nav button[aria-label="Show everyone"][role="button"]',
                    'nav button[data-panel-id="1"][role="button"]',
                ].join(', '),
            )

            const count = await buttons.count()
            showEveryOneFound = count > 0

            if (showEveryOneFound && click) {
                try {
                    await buttons.first().click()
                    console.log('Successfully clicked People button')
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
        // First check if we have been removed from the meeting
        if (await notAcceptedInMeeting(page)) {
            console.log('Bot has been removed from the meeting')
            return false
        }

        // Check elements that indicate we are in the meeting
        const indicators = [
            // La présence des contrôles de réunion
            await page
                .locator('div[role="region"][aria-label="Call controls"]')
                .isVisible(),

            // La présence du bouton "People" ou du nombre de participants
            await page
                .locator(
                    '[aria-label*="participant"], [aria-label="Show everyone"]',
                )
                .isVisible(),

            // La présence du bouton de chat
            await page
                .locator('button[aria-label*="Chat with everyone"]')
                .isVisible(),
        ]

        const confirmedIndicators = indicators.filter(Boolean).length
        console.log(`Meeting presence indicators: ${confirmedIndicators}/3`)

        // We consider we are in the meeting if at least 2 indicators are present
        return confirmedIndicators >= 2
    } catch (error) {
        console.error('Error checking if in meeting:', error)
        return false
    }
}

async function sendEntryMessage(
    page: Page,
    enterMessage: string,
): Promise<boolean> {
    console.log('Attempting to send entry message...')
    // First check if we are still in the meeting
    if (!(await isInMeeting(page))) {
        console.log(
            'Bot is no longer in the meeting, cannot send entry message',
        )
        return false
    }

    // truncate the message as meet only allows 516 characters
    enterMessage = enterMessage.substring(0, 500)
    try {
        await page.click('button[aria-label="Chat with everyone"]')
        await page.waitForSelector(
            'textarea[placeholder="Send a message"], textarea[aria-label="Send a message to everyone"]',
            { state: 'visible' },
        )

        // Check again if we are still in the meeting
        if (!(await isInMeeting(page))) {
            console.log('Bot is no longer in the meeting after opening chat')
            return false
        }

        const textarea = page.locator(
            'textarea[placeholder="Send a message"], textarea[aria-label="Send a message to everyone"]',
        )
        await textarea.fill(enterMessage)

        const sendButton = page.locator('button:has(i:text("send"))')
        if ((await sendButton.count()) > 0) {
            await sendButton.click()
            console.log('Clicked on send button')
            await page.click('button[aria-label="Chat with everyone"]')
            return true
        }
        console.log('Send button not found')
        return false
    } catch (error) {
        console.error('Failed to send entry message:', error)
        return false
    }
}

async function notAcceptedInMeeting(page: Page): Promise<boolean> {
    // Generic user-denied entry texts
    const deniedTexts = [
        'denied',
        "You've been removed",
        'we encountered a problem joining',
        "You can't join",
        'You left the meeting', // Happens if the bot first entered in the waiting room of the meeting (not the entry page) and then it was denied entry
    ]

    // Google Meet itself has denied entry
    const googleMeetDeniedTexts = ["You can't join this video call"]

    // Google Meet has its own timeout which would deny entry into the meeting after ~10 minutes
    const timeoutTextsFromGoogle = [
        'No one responded to your request to join the call',
    ]

    // Check for Google Meet denied texts first since the message overlaps with the user denied entry message
    for (const text of googleMeetDeniedTexts) {
        const element = page.locator(`text=${text}`)
        if ((await element.count()) > 0) {
            // Google Meet itself has denied entry
            console.log(
                'XXXXXXXXXXXXXXXXXX Google Meet itself has denied entry',
            )
            GLOBAL.setError(
                MeetingEndReason.BotNotAccepted,
                'Google Meet has denied entry',
            )
            return true
        }
    }

    // Check for Google Meet timeout texts
    for (const text of timeoutTextsFromGoogle) {
        const element = page.locator(`text=${text}`)
        if ((await element.count()) > 0) {
            // Google Meet itself has timed out
            console.log('XXXXXXXXXXXXXXXXXX Google Meet itself has timed out')
            GLOBAL.setError(
                MeetingEndReason.TimeoutWaitingToStart,
                'Google Meet has timed out while waiting for the bot to join the meeting',
            )
            return true
        }
    }

    // Check for user denied entry texts
    for (const text of deniedTexts) {
        const element = page.locator(`text=${text}`)
        if ((await element.count()) > 0) {
            // User has denied entry
            console.log('XXXXXXXXXXXXXXXXXX User has denied entry')
            GLOBAL.setError(MeetingEndReason.BotNotAccepted)
            return true
        }
    }

    return false
}

async function clickDismiss(page: Page): Promise<boolean> {
    try {
        const dismissButton = await page
            .locator('div[role=button]')
            .filter({ hasText: 'Dismiss' })
            .first()
        if ((await dismissButton.count()) > 0) {
            await dismissButton.click()
            return true
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

async function changeLayout(
    page: Page,
    currentAttempt = 1,
    maxAttempts = 3,
): Promise<boolean> {
    console.log(
        `Starting layout change process (attempt ${currentAttempt}/${maxAttempts})...`,
    )

    try {
        // Capture DOM state before layout change operation (first attempt only)
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        if (currentAttempt === 1) {
            await htmlSnapshot.captureSnapshot(
                page,
                'meet_layout_change_operation_start_attempt_1',
            )
        }

        // First check if we are still in the meeting
        if (!(await isInMeeting(page))) {
            console.log(
                'Bot is no longer in the meeting, stopping layout change',
            )
            return false
        }

        // Réduire le timeout de networkidle et ajouter un timeout plus court pour les éléments
        await page
            .waitForLoadState('networkidle', { timeout: 5000 })
            .catch(() => {
                console.log('Network idle timeout, continuing anyway...')
            })

        // 1. Cliquer sur le bouton "More options"
        console.log('Looking for More options button in call controls...')

        // Capture DOM state before clicking More options
        await htmlSnapshot.captureSnapshot(
            page,
            `meet_layout_change_before_more_options_attempt_${currentAttempt}`,
        )

        const moreOptionsButton = page.locator(
            'div[role="region"][aria-label="Call controls"] button[aria-label="More options"]',
        )
        await moreOptionsButton.waitFor({ state: 'visible', timeout: 3000 })
        await moreOptionsButton.click()
        await page.waitForTimeout(500)

        // Check again if we are still in the meeting
        if (!(await isInMeeting(page))) {
            console.log(
                'Bot is no longer in the meeting after clicking More options',
            )
            return false
        }

        // 2. Cliquer sur "Change layout" ou "Adjust view"
        console.log('Looking for Change layout/Adjust view menu item...')

        // Capture DOM state after More options menu opens
        await htmlSnapshot.captureSnapshot(
            page,
            `meet_layout_change_more_options_menu_open_attempt_${currentAttempt}`,
        )

        const changeLayoutItem = page.locator(
            '[role="menu"] [role="menuitem"]:has(span:has-text("Change layout"), span:has-text("Adjust view"))',
        )
        await changeLayoutItem.waitFor({ state: 'visible', timeout: 3000 })
        await htmlSnapshot.captureSnapshot(
            page,
            `meet_layout_change_change_layout_menu_item_found_attempt_${currentAttempt}`,
        )

        await changeLayoutItem.click()
        await page.waitForTimeout(500)

        // Check again if we are still in the meeting
        if (!(await isInMeeting(page))) {
            console.log(
                'Bot is no longer in the meeting after clicking Change layout',
            )
            return false
        }

        // 3. Cliquer sur "Spotlight"
        console.log('Looking for Spotlight option...')
        const spotlightOption = page.locator(
            [
                'label:has-text("Spotlight"):has(input[type="radio"])',
                'label:has(input[name="preferences"]):has-text("Spotlight")',
                'label:has(span:text-is("Spotlight"))',
            ].join(','),
        )

        const count = await spotlightOption.count()
        console.log(`Found ${count} Spotlight options`)

        await spotlightOption.waitFor({ state: 'visible', timeout: 3000 })
        console.log('Clicking Spotlight option...')
        await spotlightOption.click()
        await page.waitForTimeout(500)

        // Check one last time if we are still in the meeting
        if (!(await isInMeeting(page))) {
            console.log(
                'Bot is no longer in the meeting after clicking Spotlight',
            )
            return false
        }

        await clickOutsideModal(page)
        return true
    } catch (error) {
        console.error(`Error in changeLayout attempt ${currentAttempt}:`, {
            message: (error as Error).message,
            stack: (error as Error).stack,
        })

        const htmlSnapshot = HtmlSnapshotService.getInstance()
        await htmlSnapshot.captureSnapshot(
            page,
            `meet_layout_change_operation_failure_attempt_${currentAttempt}`,
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
