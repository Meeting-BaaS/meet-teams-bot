import { Page } from '@playwright/test'
import { HtmlSnapshotService } from '../../services/html-snapshot-service'
import { RecordingMode } from '../../types'

export class MeetHtmlCleaner {
    private page: Page
    private recordingMode: RecordingMode

    constructor(page: Page, recordingMode: RecordingMode) {
        this.page = page
        this.recordingMode = recordingMode
    }

    public async start(): Promise<void> {
        console.log('[Meet] Starting HTML cleaner')

        // Capture DOM state before starting HTML cleaning
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        await htmlSnapshot.captureSnapshot(
            this.page,
            'meet_html_cleaner_before_cleaning',
        )

        // Inject Meet provider logic into browser context
        await this.page.evaluate(async (recordingMode) => {
            async function removeInitialShityHtml(mode: string) {
                let div
                try {
                    document
                        .querySelectorAll('[data-purpose="non-essential-ui"]')
                        .forEach(
                            (elem) =>
                                ((elem as HTMLElement).style.display = 'none'),
                        )
                } catch (e) {}
                try {
                    for (div of document.getElementsByTagName('div')) {
                        if (
                            div.clientWidth === 360 &&
                            div.clientHeight === 326
                        ) {
                            div.style.display = 'none'
                        }
                    }
                } catch (e) {}
                try {
                    for (div of document.getElementsByTagName('div')) {
                        if (div.clientHeight === 26) {
                            div.style.display = 'none'
                        }
                    }
                } catch (e) {}
                try {
                    const bannerDiv = document.querySelector(
                        'div[role="banner"]',
                    ) as HTMLElement
                    if (bannerDiv) {
                        bannerDiv.style.opacity = '0'
                    }
                } catch (e) {}
                try {
                    for (div of document.getElementsByTagName('div')) {
                        if (div.clientHeight === 20) {
                            div.style.display = 'none'
                        }
                    }
                } catch (e) {}
                try {
                    let span
                    for (span of document.getElementsByTagName('span')) {
                        if (span.innerText.includes(':')) {
                            span.parentElement.parentElement.style.display =
                                'none'
                        }
                    }
                } catch (e) {}
                try {
                    removeBlackBox()
                } catch (e) {}
                try {
                    const politeDivs = document.querySelectorAll(
                        'div[aria-live="polite"]',
                    )
                    politeDivs.forEach((div) => {
                        ;(div as HTMLElement).style.opacity = '0'
                    })
                } catch (e) {}

                // Hide visitor indicator bar
                hideVisitorIndicator()

                // People panel cleanup
                let root: any = null
                while (root == null) {
                    root = (Array as any)
                        .from(document.querySelectorAll('div'))
                        .find((d) => d.innerText === 'People')
                        ?.parentElement?.parentElement
                    if (root != null) {
                        try {
                            root.parentElement.style.opacity = 0
                            root.parentElement.parentElement.style.opacity = 0
                            const rootLeft = (Array as any)
                                .from(document.querySelectorAll('div'))
                                .find((d) => d.innerText === 'You')
                            rootLeft.parentElement.parentElement.parentElement.parentElement.style.width =
                                '97vw'
                        } catch (e) {}
                    }
                }

                if (mode !== 'gallery_view') {
                    try {
                        const video = document.getElementsByTagName(
                            'video',
                        )[0] as HTMLVideoElement
                        if (video) {
                            video.style.position = 'fixed'
                            video.style.display = 'block'
                            video.style.left = '0'
                            video.style.top = '0'
                            video.style.zIndex = '900000'
                            if (video?.parentElement?.style) {
                                video.parentElement.style.background = '#000'
                                video.parentElement.style.top = '0'
                                video.parentElement.style.left = '0'
                                video.parentElement.style.width = '100vw'
                                video.parentElement.style.height = '100vh'
                                video.parentElement.style.position = 'fixed'
                                video.parentElement.style.display = 'flex'
                                video.parentElement.style.alignItems = 'center'
                                video.parentElement.style.justifyContent =
                                    'center'
                            }
                        }
                    } catch (e) {}
                }
            }

            function removeShityHtml(mode: string) {
                if (mode !== 'gallery_view') {
                    try {
                        const video = document.getElementsByTagName(
                            'video',
                        )[0] as HTMLVideoElement
                        if (video) {
                            video.style.position = 'fixed'
                            video.style.display = 'block'
                            video.style.left = '0'
                            video.style.top = '0'
                            video.style.zIndex = '1'
                            if (video?.parentElement?.style) {
                                video.parentElement.style.background = '#000'
                                video.parentElement.style.top = '0'
                                video.parentElement.style.left = '0'
                                video.parentElement.style.width = '100vw'
                                video.parentElement.style.height = '100vh'
                                video.parentElement.style.position = 'fixed'
                                video.parentElement.style.display = 'flex'
                                video.parentElement.style.alignItems = 'center'
                                video.parentElement.style.justifyContent =
                                    'center'
                            }
                        }
                    } catch (e) {}
                    try {
                        document.getElementsByTagName(
                            'video',
                        )[1].style.position = 'fixed'
                    } catch (e) {}
                }

                try {
                    const bannerDiv = document.querySelector(
                        'div[role="banner"]',
                    ) as HTMLElement
                    if (bannerDiv) {
                        bannerDiv.style.opacity = '0'
                    }
                } catch (e) {}
                try {
                    for (const div of document.getElementsByTagName('div')) {
                        if (
                            div.clientHeight === 164 &&
                            div.clientWidth === 322
                        ) {
                            div.style.display = 'none'
                        }
                    }
                } catch (e) {}
                try {
                    for (const div of document.getElementsByTagName('div')) {
                        if (div.clientHeight === 40) {
                            div.style.opacity = '0'
                        }
                    }
                } catch (e) {}
                try {
                    const politeDivs = document.querySelectorAll(
                        'div[aria-live="polite"]',
                    )
                    politeDivs.forEach((div) => {
                        ;(div as HTMLElement).style.opacity = '0'
                    })
                } catch (e) {}
                try {
                    var icons = Array.from(
                        document.querySelectorAll('i.google-material-icons'),
                    ).filter((el) => el.textContent?.trim() === 'devices')
                    icons.forEach((icon) => {
                        if (icon.parentElement) {
                            icon.parentElement.style.opacity = '0'
                        }
                    })
                } catch (e) {}

                // People panel cleanup
                let root: any = null
                while (root == null) {
                    root = (Array as any)
                        .from(document.querySelectorAll('div'))
                        .find((d) => d.innerText === 'People')
                        ?.parentElement?.parentElement
                    if (root != null) {
                        try {
                            root.parentElement.style.opacity = 0
                            root.parentElement.parentElement.style.opacity = 0
                            const rootLeft = (Array as any)
                                .from(document.querySelectorAll('div'))
                                .find((d) => d.innerText === 'You')
                            rootLeft.parentElement.parentElement.parentElement.parentElement.style.width =
                                '97vw'
                        } catch (e) {}
                    }
                }

                try {
                    var moodIcons = Array.from(
                        document.querySelectorAll('i.google-material-icons'),
                    ).filter((el) => el.textContent?.trim() === 'mood')
                    if (moodIcons.length > 0) {
                        var icon = moodIcons[0]
                        var currentElement = icon.parentElement
                        while (currentElement != null) {
                            var bgColor =
                                window.getComputedStyle(
                                    currentElement,
                                ).backgroundColor
                            if (bgColor === 'rgb(32, 33, 36)') {
                                currentElement.style.opacity = '0'
                                break
                            }
                            currentElement = currentElement.parentElement
                        }
                    }
                } catch (e) {}

                // Hide visitor indicator bar
                hideVisitorIndicator()
            }

            function hideVisitorIndicator(): void {
                try {
                    const visitorIcons = Array.from(
                        document.querySelectorAll('i.google-material-icons'),
                    ).filter(
                        (el) => el.textContent?.trim() === 'domain_disabled',
                    )
                    visitorIcons.forEach((icon) => {
                        let currentElement = icon.parentElement
                        while (currentElement != null) {
                            // Look for elements with aria-label containing "Visitor" or similar
                            const ariaLabel =
                                currentElement.getAttribute('aria-label')
                            if (
                                ariaLabel &&
                                (ariaLabel.toLowerCase().includes('visitor') ||
                                    ariaLabel
                                        .toLowerCase()
                                        .includes('indicator') ||
                                    ariaLabel
                                        .toLowerCase()
                                        .includes('organisation'))
                            ) {
                                currentElement.style.opacity = '0'
                                break
                            }
                            // Also check for tooltip content about visitors
                            const tooltip =
                                currentElement.querySelector('[role="tooltip"]')
                            if (
                                tooltip &&
                                tooltip.textContent &&
                                tooltip.textContent
                                    .toLowerCase()
                                    .includes('visitor')
                            ) {
                                currentElement.style.opacity = '0'
                                break
                            }
                            currentElement = currentElement.parentElement
                        }
                    })
                } catch (e) {}
            }

            function removeBlackBox(): void {
                const elements: NodeListOf<HTMLElement> =
                    document.querySelectorAll('[data-layout="roi-crop"]')
                if (elements.length === 0) {
                    return
                }

                let maxWidth: number = 0
                let maxElement: HTMLElement | null = null
                elements.forEach((el: HTMLElement) => {
                    const width: number = el.offsetWidth
                    if (width > maxWidth) {
                        maxWidth = width
                        maxElement = el
                    }
                })

                elements.forEach((el: HTMLElement) => {
                    if (el == maxElement) {
                        el.style.opacity = '1'
                        el.style.top = '0'
                        el.style.left = '0'
                        el.style.position = 'fixed'
                        el.style.zIndex = '9000'
                        el.style.backgroundColor = 'black'

                        // Also apply parent styling to the main element
                        let element = el.parentElement
                        let depth = 4
                        while (depth >= 0 && element) {
                            element.style.opacity = '1'
                            element.style.border = 'transparent'
                            element.style.clipPath = 'none'
                            element = element.parentElement
                            depth--
                        }
                    } else {
                        let element = el
                        let depth = 4
                        while (depth >= 0 && element) {
                            element.style.opacity = '0'
                            element.style.border = 'transparent'
                            element.style.clipPath = 'none'
                            element = element.parentElement
                            depth--
                        }
                    }
                })
            }

            // Execute Meet provider
            console.log('[Meet] Executing HTML provider')
            await removeInitialShityHtml(recordingMode)

            // Setup continuous cleanup
            const observer = new MutationObserver(() => {
                removeShityHtml(recordingMode)
            })

            if (document.documentElement) {
                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                })
            }

            ;(window as any).htmlCleanerObserver = observer
            console.log('[Meet] HTML provider complete')
        }, this.recordingMode)
    }

    public async stop(): Promise<void> {
        console.log('[Meet] Stopping HTML cleaner')

        await this.page
            .evaluate(() => {
                if ((window as any).htmlCleanerObserver) {
                    ;(window as any).htmlCleanerObserver.disconnect()
                    delete (window as any).htmlCleanerObserver
                }
            })
            .catch((e) => console.error('[Meet] HTML cleaner stop error:', e))

        console.log('[Meet] HTML cleaner stopped')
    }
}
