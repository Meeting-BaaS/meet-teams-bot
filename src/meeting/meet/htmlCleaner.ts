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

                // People panel cleanup (check once, skip if not found)
                try {
                    const root = (Array as any)
                        .from(document.querySelectorAll('div'))
                        .find((d) => d.innerText === 'People')
                        ?.parentElement?.parentElement
                    if (root) {
                        root.parentElement.style.opacity = 0
                        root.parentElement.parentElement.style.opacity = 0
                        const rootLeft = (Array as any)
                            .from(document.querySelectorAll('div'))
                            .find((d) => d.innerText === 'You')
                        if (rootLeft) {
                            rootLeft.parentElement.parentElement.parentElement.parentElement.style.width =
                                '97vw'
                        }
                    }
                } catch (e) {}

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
                            (div.clientHeight === 164 &&
                                div.clientWidth === 322) ||
                            div.clientHeight === 36 // For the new People Icon at the top right corner
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

                // People panel cleanup (check once, skip if not found)
                try {
                    const root = (Array as any)
                        .from(document.querySelectorAll('div'))
                        .find((d) => d.innerText === 'People')
                        ?.parentElement?.parentElement
                    if (root) {
                        root.parentElement.style.opacity = 0
                        root.parentElement.parentElement.style.opacity = 0
                        const rootLeft = (Array as any)
                            .from(document.querySelectorAll('div'))
                            .find((d) => d.innerText === 'You')
                        if (rootLeft) {
                            rootLeft.parentElement.parentElement.parentElement.parentElement.style.width =
                                '97vw'
                        }
                    }
                } catch (e) {}

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

            /**
             * Removes black borders from screen sharing video in Google Meet.
             * When screen sharing starts, Google Meet creates [data-layout="roi-crop"] elements
             * that contain the shared screen video. These elements often have fixed pixel widths
             * (e.g., 982px) instead of full viewport width, causing black bars on the right side.
             * This function:
             * 1. Finds the largest roi-crop element (the main screen share)
             * 2. Sets it and its parents to full viewport width/height (100vw/100vh)
             * 3. Styles the video element using object-fit: contain
             *    (maintains aspect ratio, may show black bars if aspect ratios don't match)
             */
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
                        // Set full viewport dimensions to eliminate black bars on the right
                        // Previously, roi-crop elements had fixed pixel widths (e.g., 982px)
                        // which didn't fill the entire screen, causing black borders
                        el.style.width = '100vw'
                        el.style.height = '100vh'

                        // Style video elements inside roi-crop to fill container
                        // Using object-fit: contain maintains the video's aspect ratio
                        // and ensures it fits within the container without distortion.
                        // May show black bars if aspect ratios don't match, but preserves video quality.
                        const videos = el.querySelectorAll('video')
                        videos.forEach((video: HTMLVideoElement) => {
                            video.style.width = '100%'
                            video.style.height = '100%'
                            video.style.objectFit = 'contain'
                        })

                        // Also apply parent styling to ensure all container layers are full width
                        // Parent elements may also have fixed widths that need to be overridden
                        let element = el.parentElement
                        let depth = 4
                        while (depth >= 0 && element) {
                            element.style.opacity = '1'
                            element.style.border = 'none'
                            element.style.clipPath = 'none'
                            // Set parent containers to full viewport width/height as well
                            // This ensures the entire container hierarchy fills the screen
                            element.style.width = '100vw'
                            element.style.height = '100vh'
                            element = element.parentElement
                            depth--
                        }
                    } else {
                        let element = el
                        let depth = 4
                        while (depth >= 0 && element) {
                            element.style.opacity = '0'
                            element.style.border = 'none'
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

            // Setup continuous cleanup using setInterval instead of MutationObserver
            // for more consistent execution. This ensures removeShityHtml() and
            // removeBlackBox() are called every 500ms to handle dynamically added
            // elements (e.g., when screen sharing starts).
            const cleanupInterval = setInterval(() => {
                removeShityHtml(recordingMode)
                // Call removeBlackBox() to handle dynamically added
                // [data-layout="roi-crop"] elements (e.g., when screen sharing starts).
                // Without this, screen sharing elements added after initial load won't
                // have their black borders removed and won't fill the full viewport.
                removeBlackBox()
            }, 500)

            ;(window as any).htmlCleanerInterval = cleanupInterval
            console.log('[Meet] HTML provider complete')
        }, this.recordingMode)
    }

    public async stop(): Promise<void> {
        console.log('[Meet] Stopping HTML cleaner')

        await this.page
            .evaluate(() => {
                if ((window as any).htmlCleanerInterval) {
                    clearInterval((window as any).htmlCleanerInterval)
                    delete (window as any).htmlCleanerInterval
                }
            })
            .catch((e) => console.error('[Meet] HTML cleaner stop error:', e))

        console.log('[Meet] HTML cleaner stopped')
    }
}
