import { Page } from '@playwright/test'
import { RecordingMode } from '../../types'
import { HtmlSnapshotService } from '../../services/html-snapshot-service'

export class TeamsHtmlCleaner {
    private page: Page
    private recordingMode: RecordingMode

    constructor(page: Page, recordingMode: RecordingMode) {
        this.page = page
        this.recordingMode = recordingMode
    }

    public async start(): Promise<void> {
        console.log('[Teams] Starting HTML cleaner')

        // Capture DOM state before starting Teams HTML cleaning
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        await htmlSnapshot.captureSnapshot(
            this.page,
            'teams_html_cleaner_before_cleaning',
        )

        // Wait 1 second like in original extension
        await this.page.waitForTimeout(1000)

        // Inject Teams provider logic into browser context
        await this.page.evaluate(async (recordingMode) => {
            // EXACT TEAMS PROVIDER FUNCTIONS FROM ORIGINAL EXTENSION
            function getDocumentRoot(): Document {
                for (let iframe of document.querySelectorAll('iframe')) {
                    try {
                        const doc =
                            iframe.contentDocument ||
                            iframe.contentWindow?.document
                        if (doc) {
                            console.log('[Teams] Document root found in iframe')
                            return doc
                        }
                    } catch (e) {
                        console.warn(
                            '[Teams] Error accessing iframe content',
                            e,
                        )
                    }
                }
                console.log('[Teams] Using main document as root')
                return document
            }

            async function removeInitialShityHtml() {
                console.log('[Teams] Starting removeInitialShityHtml')
                await new Promise((resolve) => setTimeout(resolve, 1000))
                const documentRoot = getDocumentRoot()
                try {
                    const meetingControls = documentRoot.querySelectorAll(
                        `div[data-tid="app-layout-area--header"]`,
                    )
                    if (meetingControls[0] instanceof HTMLElement) {
                        meetingControls[0].style.opacity = '0'
                        console.log('[Teams] Meeting controls hidden')
                    }
                } catch (e) {
                    console.error('[Teams] Failed to remove buttons header', e)
                }

                try {
                    const style = documentRoot.createElement('style')
                    documentRoot.head.appendChild(style)
                    const sheet = style.sheet
                    sheet?.insertRule(
                        `
                        [data-tid="voice-level-stream-outline"]::before {
                          border: 0px solid rgb(127, 133, 245);
                        }
                      `,
                        sheet.cssRules.length,
                    )
                    console.log(
                        '[Teams] Voice level stream outline style added',
                    )
                } catch (e) {
                    console.error('[Teams] Error in insert before style', e)
                }

                try {
                    const mainArea = documentRoot.querySelector(
                        'div[data-tid="app-layout-area--main"]',
                    )
                    if (mainArea instanceof HTMLElement) {
                        mainArea.style.height = '100vh'
                        mainArea.style.width = '100vw'
                    }
                } catch (e) {
                    console.error('[Teams] Failed to modify main area', e)
                }
            }

            function removeShityHtml() {
                console.log('[Teams] Starting removeShityHtml')
                const documentRoot = getDocumentRoot()
                try {
                    const menus = documentRoot.querySelectorAll('[role="menu"]')
                    const menu = menus[0] || menus
                    if (menu instanceof HTMLElement) {
                        menu.style.position = 'fixed'
                        menu.style.top = '0'
                        menu.style.left = '0'
                        menu.style.width = '100vw'
                        menu.style.height = '100vh'
                        menu.style.zIndex = '9999'
                        menu.style.backgroundColor = 'black'
                        console.log('[Teams] Menu element hidden')
                    }
                } catch (e) {
                    console.error('[Teams] Error in remove shitty html', e)
                }

                try {
                    let hiddenDivs = 0
                    documentRoot.querySelectorAll('div').forEach((div) => {
                        if (
                            (div as HTMLElement).clientHeight === 137 &&
                            (div as HTMLElement).clientWidth === 245
                        ) {
                            ;(div as HTMLElement).style.opacity = '0'
                            hiddenDivs++
                        }
                    })
                    console.log(
                        '[Teams] Hidden',
                        hiddenDivs,
                        'additional elements',
                    )
                } catch (e) {
                    console.error(
                        '[Teams] Error in remove additional elements',
                        e,
                    )
                }

                try {
                    const mainArea = documentRoot.querySelector(
                        'div[data-tid="app-layout-area--main"]',
                    )
                    if (mainArea instanceof HTMLElement) {
                        mainArea.style.height = '100vh'
                        mainArea.style.width = '100vw'
                    }
                } catch (e) {
                    console.error('[Teams] Failed to modify main area', e)
                }
            }

            // Execute Teams provider
            console.log('[Teams] Executing HTML provider')
            await removeInitialShityHtml()

            // Setup continuous cleanup
            const observer = new MutationObserver(() => {
                removeShityHtml()
            })

            if (document.documentElement) {
                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                })
            }

            ;(window as any).htmlCleanerObserver = observer
            console.log('[Teams] HTML provider complete')
        }, this.recordingMode)
    }

    public async stop(): Promise<void> {
        console.log('[Teams] Stopping HTML cleaner')

        await this.page
            .evaluate(() => {
                if ((window as any).htmlCleanerObserver) {
                    ;(window as any).htmlCleanerObserver.disconnect()
                    delete (window as any).htmlCleanerObserver
                }
            })
            .catch((e) => console.error('[Teams] HTML cleaner stop error:', e))

        console.log('[Teams] HTML cleaner stopped')
    }
}
