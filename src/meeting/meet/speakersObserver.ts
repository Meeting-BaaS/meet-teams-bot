import { Page } from '@playwright/test'
import { RecordingMode, SpeakerData } from '../../types'
import { HtmlSnapshotService } from '../../services/html-snapshot-service'

export class MeetSpeakersObserver {
    private page: Page
    private recordingMode: RecordingMode
    private botName: string
    private onSpeakersChange: (speakers: SpeakerData[]) => void
    private isObserving: boolean = false

    private readonly SPEAKER_LATENCY = 0 // ms
    private readonly MUTATION_DEBOUNCE = 50 // ms
    private readonly CHECK_INTERVAL = 10000 // 10s
    private readonly FREEZE_TIMEOUT = 8000 // 8s

    constructor(
        page: Page,
        recordingMode: RecordingMode,
        botName: string,
        onSpeakersChange: (speakers: SpeakerData[]) => void,
    ) {
        this.page = page
        this.recordingMode = recordingMode
        this.botName = botName
        this.onSpeakersChange = onSpeakersChange
    }

    public async startObserving(): Promise<void> {
        if (this.isObserving) {
            console.warn('[Meet] Already observing')
            return
        }

        console.log('[Meet] Starting speaker observation...')

        // Browser console logs are handled by centralized page-logger in base-state.ts

        // EXACT SAME AS EXTENSION: Ensure People panel is open
        await this.ensurePeoplePanelOpen()

        // Expose callback function to the page
        await this.page.exposeFunction(
            'meetSpeakersChanged',
            async (speakers: SpeakerData[]) => {
                try {
                    console.log(
                        `[Meet] 🗣️ CALLBACK RECEIVED: ${speakers.length} speakers from browser`,
                    )
                    this.onSpeakersChange(speakers)
                    // console.log(`[Meet] ✅ onSpeakersChange callback completed`)
                } catch (error) {
                    console.error(
                        '[Meet] ❌ Error in speakers callback:',
                        error,
                    )
                }
            },
        )

        // Inject EXACT SAME LOGIC as extension but via Playwright
        await this.page.evaluate(
            ({
                recordingMode,
                botName,
                speakerLatency,
                mutationDebounce,
                checkInterval,
                freezeTimeout,
            }) => {
                console.log(
                    '[Meet-Browser] Setting up observation - EXACT EXTENSION LOGIC',
                )

                // EXACT SAME VARIABLES AS EXTENSION
                let CUR_SPEAKERS = new Map<string, boolean>()
                let checkSpeakersTimeout: any = null
                let lastMutationTime = Date.now()
                let MUTATION_OBSERVER: MutationObserver | null = null
                let periodicCheck: any = null

                // EXACT SAME freeze detection variables as extension
                let lastValidSpeakers: SpeakerData[] = []
                let lastValidSpeakerCheck = Date.now()
                const FREEZE_TIMEOUT_MS = 30000 // 30 seconds

                // EXACT SAME getSpeakerRootToObserve as extension
                async function getSpeakerRootToObserve(
                    recordingMode: string,
                ): Promise<[Node, MutationObserverInit] | undefined> {
                    if (recordingMode === 'gallery_view') {
                        return [
                            document,
                            {
                                attributes: true,
                                characterData: false,
                                childList: true,
                                subtree: true,
                                attributeFilter: ['class'],
                            },
                        ]
                    } else {
                        try {
                            // Find all div elements
                            const allDivs = document.querySelectorAll('div')

                            // Filter divs to include padding in their size (assuming border-box sizing)
                            const filteredDivs = Array.from(allDivs).filter(
                                (div) => {
                                    // Use offsetWidth and offsetHeight to include padding (and border)
                                    const width = div.offsetWidth
                                    const height = div.offsetHeight

                                    return (
                                        width === 360 &&
                                        (height === 64 ||
                                            height === 63 ||
                                            height === 50.99 ||
                                            height === 51 ||
                                            height === 66.63)
                                    )
                                },
                            )

                            // We no longer remove these divs to avoid disrupting the interface

                            // Observe the entire document instead of the participants panel
                            return [
                                document,
                                {
                                    attributes: true,
                                    characterData: false,
                                    childList: true,
                                    subtree: true,
                                    attributeFilter: ['class', 'aria-label'],
                                },
                            ]
                        } catch (error) {
                            console.error(
                                'Error in getSpeakerRootToObserve:',
                                error,
                            )
                            return [
                                document,
                                {
                                    attributes: true,
                                    characterData: false,
                                    childList: true,
                                    subtree: true,
                                    attributeFilter: ['class', 'aria-label'],
                                },
                            ]
                        }
                    }
                }

                // EXACT SAME observeIframes as extension
                function observeIframes(
                    callback: (iframe: HTMLIFrameElement) => void,
                ) {
                    // Observer les iframes existantes
                    document.querySelectorAll('iframe').forEach((iframe) => {
                        callback(iframe)
                    })

                    // Observe for new iframes
                    const observer = new MutationObserver((mutations) => {
                        mutations.forEach((mutation) => {
                            mutation.addedNodes.forEach((node) => {
                                if (node.nodeName === 'IFRAME') {
                                    callback(node as HTMLIFrameElement)
                                }
                                // Look for iframes inside added nodes
                                if (node.nodeType === Node.ELEMENT_NODE) {
                                    ;(node as Element)
                                        .querySelectorAll('iframe')
                                        .forEach((iframe) => {
                                            callback(iframe)
                                        })
                                }
                            })
                        })
                    })

                    observer.observe(document.body, {
                        childList: true,
                        subtree: true,
                    })

                    return observer
                }

                // EXACT SAME getIframeDocument as extension
                function getIframeDocument(
                    iframe: HTMLIFrameElement,
                ): Document | null {
                    try {
                        // Check if the iframe is accessible (same origin)
                        return (
                            iframe.contentDocument ||
                            iframe.contentWindow?.document ||
                            null
                        )
                    } catch (error) {
                        // If the iframe is cross-origin we cannot access it
                        console.log(
                            'Cannot access iframe content (likely cross-origin):',
                            error,
                        )
                        return null
                    }
                }

                // EXACT SAME getSpeakerFromDocument as extension
                function getSpeakerFromDocument(
                    recordingMode: string,
                    timestamp: number,
                ): SpeakerData[] {
                    try {
                        // Check if the page is frozen
                        const currentTime = Date.now()
                        if (
                            currentTime - lastValidSpeakerCheck >
                            FREEZE_TIMEOUT_MS
                        ) {
                            return []
                        }

                        const participantsList = document.querySelector(
                            "[aria-label='Participants']",
                        )
                        if (!participantsList) {
                            lastValidSpeakers = []
                            return [] // Real case of 0 participants
                        }

                        const participantItems =
                            participantsList.querySelectorAll(
                                '[role="listitem"]',
                            )

                        if (
                            !participantItems ||
                            participantItems.length === 0
                        ) {
                            lastValidSpeakers = [] // Update the current state
                            return []
                        }

                        // Map to store unique participants with their speaking status
                        const uniqueParticipants = new Map<
                            string,
                            {
                                name: string
                                isSpeaking: boolean
                                isPresenting: boolean
                                isInMergedAudio: boolean
                                cohortId: string | null
                            }
                        >()

                        // Data structure for merged groups
                        const mergedGroups = new Map<
                            string,
                            {
                                isSpeaking: boolean
                                members: string[]
                            }
                        >()

                        // First pass: identify all participants
                        for (let i = 0; i < participantItems.length; i++) {
                            const item = participantItems[i]
                            const ariaLabel = item
                                .getAttribute('aria-label')
                                ?.trim()

                            if (!ariaLabel) continue

                            // Check if this element is "Merged audio"
                            const isMergedAudio = ariaLabel === 'Merged audio'

                            // Get the cohort id for merged groups
                            let cohortId: string | null = null
                            if (isMergedAudio) {
                                // Look for the cohort id in the parent element
                                const cohortElement =
                                    item.closest('[data-cohort-id]')
                                if (cohortElement) {
                                    cohortId =
                                        cohortElement.getAttribute(
                                            'data-cohort-id',
                                        )
                                }

                                // Check if the merged audio is speaking + NEW COLOR
                                const speakingIndicators = Array.from(
                                    item.querySelectorAll('*'),
                                ).filter((elem) => {
                                    const color =
                                        getComputedStyle(elem).backgroundColor
                                    return (
                                        color === 'rgba(26, 115, 232, 0.9)' ||
                                        color === 'rgb(26, 115, 232)' ||
                                        color === 'rgb(11, 87, 208)' // NEW Meet speaking color!
                                    )
                                })

                                // Also check for the unmuted microphone icon
                                const unmutedMicImg = item.querySelector(
                                    'img[src*="mic_unmuted"]',
                                )

                                const isSpeaking =
                                    speakingIndicators.length > 0 ||
                                    !!unmutedMicImg

                                // Initialize the merged group
                                if (cohortId) {
                                    mergedGroups.set(cohortId, {
                                        isSpeaking: isSpeaking,
                                        members: [],
                                    })
                                }
                            }

                            // Check if this participant is part of a merged audio group
                            const isInMergedAudio = !!item.querySelector(
                                '[aria-label="Adaptive audio group"]',
                            )
                            let participantCohortId: string | null = null

                            if (isInMergedAudio) {
                                // Look for the cohort id in the parent element
                                const cohortElement =
                                    item.closest('[data-cohort-id]')
                                if (cohortElement) {
                                    participantCohortId =
                                        cohortElement.getAttribute(
                                            'data-cohort-id',
                                        )
                                }

                                // Add this participant to the matching merged group
                                if (
                                    participantCohortId &&
                                    mergedGroups.has(participantCohortId)
                                ) {
                                    mergedGroups
                                        .get(participantCohortId)!
                                        .members.push(ariaLabel)
                                }
                            }

                            // Add the participant to our map only if not in a merged group
                            // or if it is the "Merged audio" entry itself
                            if (isMergedAudio || !isInMergedAudio) {
                                const uniqueKey =
                                    isMergedAudio && cohortId
                                        ? `Merged audio_${cohortId}`
                                        : ariaLabel

                                if (!uniqueParticipants.has(uniqueKey)) {
                                    uniqueParticipants.set(uniqueKey, {
                                        name: ariaLabel,
                                        isSpeaking: false,
                                        isPresenting: false,
                                        isInMergedAudio: isMergedAudio,
                                        cohortId: isMergedAudio
                                            ? cohortId
                                            : null,
                                    })
                                }

                                const participant =
                                    uniqueParticipants.get(uniqueKey)!

                                // Check if the participant is presenting
                                const allDivs = Array.from(
                                    item.querySelectorAll('div'),
                                )
                                const isPresenting = allDivs.some((div) => {
                                    const text = div.textContent?.trim()
                                    return text === 'Presentation'
                                })

                                if (isPresenting) {
                                    participant.isPresenting = true
                                }

                                // Check speaking indicators + NEW COLOR FIX
                                const speakingIndicators = Array.from(
                                    item.querySelectorAll('*'),
                                ).filter((elem) => {
                                    const color =
                                        getComputedStyle(elem).backgroundColor
                                    return (
                                        color === 'rgba(26, 115, 232, 0.9)' ||
                                        color === 'rgb(26, 115, 232)' ||
                                        color === 'rgb(11, 87, 208)' // NEW Meet speaking color!
                                    )
                                })

                                speakingIndicators.forEach((indicator) => {
                                    const backgroundElement =
                                        indicator.children[1]
                                    if (backgroundElement) {
                                        const backgroundPosition =
                                            getComputedStyle(
                                                backgroundElement,
                                            ).backgroundPositionX
                                        if (backgroundPosition !== '0px') {
                                            participant.isSpeaking = true
                                        }
                                    }
                                })

                                // Update the map with the potentially modified data
                                uniqueParticipants.set(uniqueKey, participant)
                            }
                        }

                        // Replace merged group names with member names
                        for (const [
                            key,
                            participant,
                        ] of uniqueParticipants.entries()) {
                            if (
                                participant.name === 'Merged audio' &&
                                participant.cohortId &&
                                mergedGroups.has(participant.cohortId)
                            ) {
                                const members = mergedGroups.get(
                                    participant.cohortId,
                                )!.members
                                if (members.length > 0) {
                                    participant.name = members.join(', ')
                                    uniqueParticipants.set(key, participant)
                                }
                            }
                        }

                        // Build the final participant list
                        const speakers = Array.from(
                            uniqueParticipants.values(),
                        ).map((participant) => ({
                            name: participant.name,
                            id: 0,
                            timestamp,
                            isSpeaking: participant.isSpeaking,
                        }))

                        console.log(
                            `[MEET-DEBUG] Found ${speakers.length} participants:`,
                            speakers.map(
                                (s, index) =>
                                    `Speaker ${index + 1} (speaking: ${s.isSpeaking})`,
                            ),
                        )

                        lastValidSpeakers = speakers
                        lastValidSpeakerCheck = currentTime
                        return speakers
                    } catch (e) {
                        return lastValidSpeakers
                    }
                }

                // SHARED CRITICAL LOGIC from speakersUtils
                function areMapsEqual<K, V>(
                    map1: Map<K, V>,
                    map2: Map<K, V>,
                ): boolean {
                    if (map1.size !== map2.size) {
                        return false
                    }
                    for (let [key, value] of map1) {
                        if (!map2.has(key) || map2.get(key) !== value) {
                            return false
                        }
                    }
                    return true
                }

                // SHARED CRITICAL checkSpeakers logic
                async function checkSpeakers() {
                    try {
                        const timestamp = Date.now() - speakerLatency
                        let currentSpeakersList = getSpeakerFromDocument(
                            recordingMode,
                            timestamp,
                        )

                        // Filter out bot
                        currentSpeakersList = currentSpeakersList.filter(
                            (speaker) => speaker.name !== botName,
                        )

                        let new_speakers = new Map(
                            currentSpeakersList.map((elem) => [
                                elem.name,
                                elem.isSpeaking,
                            ]),
                        )

                        // Send data only when a speakers change state is detected
                        if (!areMapsEqual(CUR_SPEAKERS, new_speakers)) {
                            console.log(
                                `[MEET-DEBUG-CHANGE] Speakers changed - ${currentSpeakersList.length} total`,
                            )

                            // Simple speaker status logs
                            currentSpeakersList.forEach((speaker, index) => {
                                console.log(
                                    `[MEET-DEBUG-SPEAKER] Speaker ${index + 1} : ${speaker.isSpeaking}`,
                                )
                            })

                            // CRITICAL: Call the callback
                            console.log(
                                '[MEET-DEBUG-CALLBACK] Calling meetSpeakersChanged',
                            )
                            await (window as any).meetSpeakersChanged(
                                currentSpeakersList,
                            )

                            // CRITICAL: Update current speakers AFTER calling callback
                            CUR_SPEAKERS.clear()
                            new_speakers.forEach((value, key) =>
                                CUR_SPEAKERS.set(key, value),
                            )
                            console.log(
                                '[MEET-DEBUG-UPDATE] Speakers state updated',
                            )
                        }
                    } catch (e) {
                        console.error('[Meet] Error in checkSpeakers:', e)
                    }
                }

                // MutationObserver setup
                MUTATION_OBSERVER = new MutationObserver(function () {
                    if (checkSpeakersTimeout !== null) {
                        clearTimeout(checkSpeakersTimeout)
                    }

                    lastMutationTime = Date.now()

                    checkSpeakersTimeout = window.setTimeout(() => {
                        checkSpeakers()
                        checkSpeakersTimeout = null
                    }, mutationDebounce)
                })

                // setupMutationObserver
                async function setupMutationObserver(): Promise<boolean> {
                    try {
                        const observe_parameters =
                            await getSpeakerRootToObserve(recordingMode)

                        if (!observe_parameters || !observe_parameters[0]) {
                            console.warn(
                                '[Meet-Browser] No valid root element to observe',
                            )
                            return false
                        }

                        MUTATION_OBSERVER!.disconnect()
                        MUTATION_OBSERVER!.observe(
                            observe_parameters[0],
                            observe_parameters[1],
                        )
                        console.log(
                            '[Meet-Browser] Mutation observer successfully set up',
                        )
                        lastMutationTime = Date.now()
                        return true
                    } catch (e) {
                        console.warn(
                            '[Meet-Browser] Failed to setup mutation observer:',
                            e,
                        )
                        return false
                    }
                }

                async function observeSpeakers() {
                    try {
                        // But only send if isSpeaking === true
                        const currentSpeakersList = getSpeakerFromDocument(
                            recordingMode,
                            Date.now() - speakerLatency,
                        ).filter(
                            (speaker) =>
                                speaker.name !== botName &&
                                speaker.isSpeaking === true,
                        )

                        if (currentSpeakersList.length > 0) {
                            console.log(
                                `[MEET-DEBUG-INIT] Found ${currentSpeakersList.length} speakers already talking`,
                            )
                            await (window as any).meetSpeakersChanged(
                                currentSpeakersList,
                            )
                            // Initialize CUR_SPEAKERS with ALL speakers (speaking and not speaking)
                            const allSpeakers = getSpeakerFromDocument(
                                recordingMode,
                                Date.now() - speakerLatency,
                            ).filter((speaker) => speaker.name !== botName)
                            CUR_SPEAKERS.clear()
                            allSpeakers.forEach((elem) =>
                                CUR_SPEAKERS.set(elem.name, elem.isSpeaking),
                            )
                        }

                        await setupMutationObserver()

                        // periodic check + People panel check
                        periodicCheck = setInterval(async () => {
                            if (document.visibilityState !== 'hidden') {
                                // Check if People panel is still open - CRITICAL FOR SPEAKER DETECTION
                                const participantsList = document.querySelector(
                                    "[aria-label='Participants']",
                                )
                                if (!participantsList) {
                                    console.warn(
                                        '[Meet-Browser] People panel closed! Trying to reopen...',
                                    )
                                    // Try to reopen the panel
                                    const possibleSelectors = [
                                        "[aria-label='Show everyone']",
                                        "[aria-label='People']",
                                        "[data-tooltip='Show everyone']",
                                        "[data-tooltip='People']",
                                        "button[aria-label*='people' i]",
                                        "button[aria-label*='participants' i]",
                                    ]

                                    for (const selector of possibleSelectors) {
                                        const button = document.querySelector(
                                            selector,
                                        ) as HTMLElement
                                        if (
                                            button &&
                                            button.offsetParent !== null
                                        ) {
                                            console.log(
                                                `[Meet-Browser] Reopening People panel with: ${selector}`,
                                            )
                                            button.click()
                                            break
                                        }
                                    }
                                }

                                if (
                                    Date.now() - lastMutationTime >
                                    freezeTimeout
                                ) {
                                    console.warn(
                                        `[Meet-Browser] No mutations detected for ${freezeTimeout / 1000}s, resetting observer`,
                                    )
                                    await setupMutationObserver()
                                }
                                checkSpeakers()
                            }
                        }, checkInterval)

                        // Setup iframe observation
                        const iframeObserver = observeIframes((iframe) => {
                            const iframeDoc = getIframeDocument(iframe)
                            if (iframeDoc) {
                                // Create a new observer for the iframe content
                                const observer = new MutationObserver(
                                    (mutations) => {
                                        // Same logic as the main observer
                                        // Process mutations to detect speaker changes
                                        if (checkSpeakersTimeout !== null) {
                                            clearTimeout(checkSpeakersTimeout)
                                        }

                                        lastMutationTime = Date.now()

                                        checkSpeakersTimeout =
                                            window.setTimeout(() => {
                                                checkSpeakers()
                                                checkSpeakersTimeout = null
                                            }, mutationDebounce)
                                    },
                                )

                                // Observe the iframe document with the same parameters
                                observer.observe(iframeDoc, {
                                    attributes: true,
                                    characterData: false,
                                    childList: true,
                                    subtree: true,
                                    attributeFilter: ['class', 'aria-label'],
                                })
                            }
                        })

                        // Cleanup function
                        ;(window as any).meetObserverCleanup = () => {
                            console.log('[Meet-Browser] Cleaning up observer')
                            if (MUTATION_OBSERVER) {
                                MUTATION_OBSERVER.disconnect()
                            }
                            if (checkSpeakersTimeout) {
                                clearTimeout(checkSpeakersTimeout)
                            }
                            if (periodicCheck) {
                                clearInterval(periodicCheck)
                            }
                            if (iframeObserver) {
                                iframeObserver.disconnect()
                            }
                        }

                        // CRITICAL: Initial check
                        checkSpeakers()

                        console.log(
                            '[Meet-Browser] Observer setup complete - EXACT EXTENSION LOGIC',
                        )
                    } catch (e) {
                        console.warn(
                            '[Meet-Browser] Failed to initialize observer:',
                            e,
                        )
                        setTimeout(observeSpeakers, 5000)
                    }
                }

                // Initialize
                observeSpeakers()
            },
            {
                recordingMode: this.recordingMode,
                botName: this.botName,
                speakerLatency: this.SPEAKER_LATENCY,
                mutationDebounce: this.MUTATION_DEBOUNCE,
                checkInterval: this.CHECK_INTERVAL,
                freezeTimeout: this.FREEZE_TIMEOUT,
            },
        )

        this.isObserving = true
        console.log('[Meet] ✅ Observer started successfully')

        // Capture DOM state after Speakers Observer is started
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        await htmlSnapshot.captureSnapshot(
            this.page,
            'meet_speaker_observer_started',
        )
    }

    public stopObserving(): void {
        if (!this.isObserving) {
            return
        }

        console.log('[Meet] Stopping observation...')

        this.page
            ?.evaluate(() => {
                if ((window as any).meetObserverCleanup) {
                    ;(window as any).meetObserverCleanup()
                }
            })
            .catch((e) => console.error('[Meet] Error cleaning up:', e))

        this.isObserving = false
        console.log('[Meet] ✅ Observer stopped')
    }

    private async ensurePeoplePanelOpen(): Promise<void> {
        try {
            await this.page.evaluate(() => {
                // Check if People panel is already open
                const participantsList = document.querySelector(
                    "[aria-label='Participants']",
                )
                if (participantsList) {
                    console.log('[Meet-Browser] People panel already open')
                    return
                }

                console.log(
                    '[Meet-Browser] People panel not open, trying to open it...',
                )

                // Try multiple selectors for the people button
                const possibleSelectors = [
                    "[aria-label='Show everyone']",
                    "[aria-label='People']",
                    "[data-tooltip='Show everyone']",
                    "[data-tooltip='People']",
                    "button[aria-label*='people' i]",
                    "button[aria-label*='participants' i]",
                    "button[title*='people' i]",
                    "button[title*='participants' i]",
                ]

                for (const selector of possibleSelectors) {
                    const button = document.querySelector(
                        selector,
                    ) as HTMLElement
                    if (button && button.offsetParent !== null) {
                        // Check if visible
                        console.log(
                            `[Meet-Browser] Found people button with selector: ${selector}`,
                        )
                        button.click()

                        // Wait a bit and check if panel opened
                        setTimeout(() => {
                            const checkPanel = document.querySelector(
                                "[aria-label='Participants']",
                            )
                            if (checkPanel) {
                                console.log(
                                    '[Meet-Browser] ✅ People panel opened successfully',
                                )
                            } else {
                                console.warn(
                                    '[Meet-Browser] People panel still not visible after click',
                                )
                            }
                        }, 1000)

                        return
                    }
                }

                console.warn(
                    '[Meet-Browser] Could not find people button to open panel',
                )
            })
        } catch (error) {
            console.warn('[Meet] Failed to ensure people panel is open:', error)
        }
    }
}
