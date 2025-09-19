import { Page } from '@playwright/test'
import { RecordingMode, SpeakerData } from '../../types'
import { HtmlSnapshotService } from '../../services/html-snapshot-service'

export class TeamsSpeakersObserver {
    private page: Page
    private recordingMode: RecordingMode
    private botName: string
    private onSpeakersChange: (speakers: SpeakerData[]) => void
    private isObserving: boolean = false

    // EXACT SAME CONSTANTS AS EXTENSION
    private readonly SPEAKER_LATENCY = 1500 // ms
    private readonly MUTATION_DEBOUNCE = 50 // ms - EXACT SAME AS EXTENSION
    private readonly CHECK_INTERVAL = 10000 // 10s - EXACT SAME AS EXTENSION
    private readonly FREEZE_TIMEOUT = 8000 // 8s - EXACT SAME AS EXTENSION

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
            console.warn('[Teams] Already observing')
            return
        }

        console.log('[Teams] Starting speaker observation...')

        // Browser console logs are handled by centralized page-logger in base-state.ts

        // Expose callback function to the page
        await this.page.exposeFunction(
            'teamsSpekersChanged',
            async (speakers: SpeakerData[]) => {
                try {
                    console.log(
                        `[Teams] 📞 CALLBACK RECEIVED: ${speakers.length} speakers from browser`,
                    )
                    this.onSpeakersChange(speakers)
                    console.log(
                        `[Teams] ✅ onSpeakersChange callback completed`,
                    )
                } catch (error) {
                    console.error(
                        '[Teams] ❌ Error in speakers callback:',
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
                    '[Teams-Browser] Setting up observation - EXACT EXTENSION LOGIC',
                )

                // EXACT SAME VARIABLES AS EXTENSION
                let CUR_SPEAKERS = new Map<string, boolean>()
                let checkSpeakersTimeout: any = null
                let lastMutationTime = Date.now()
                let MUTATION_OBSERVER: MutationObserver | null = null
                let periodicCheck: any = null

                // EXACT SAME getDocumentRoot as extension
                function getDocumentRoot(): Document {
                    for (let iframe of document.querySelectorAll('iframe')) {
                        try {
                            const doc =
                                iframe.contentDocument ||
                                iframe.contentWindow?.document
                            if (doc) {
                                return doc
                            }
                        } catch (e) {
                            // Iframe access denied - cross-origin
                        }
                    }
                    return document
                }

                // EXACT SAME getSpeakerFromDocument as extension + DEBUG
                function getSpeakerFromDocument(
                    recordingMode: string,
                    timestamp: number,
                ): SpeakerData[] {
                    const documentRoot = getDocumentRoot()

                    // old and new teams - EXACT SAME AS EXTENSION
                    const oldInterfaceElements = documentRoot.querySelectorAll(
                        '[data-cid="calling-participant-stream"]',
                    )
                    const newInterfaceElements = documentRoot.querySelectorAll(
                        '[data-stream-type="Video"]',
                    )
                    // new teams live - EXACT SAME AS EXTENSION
                    const liveElements = documentRoot.querySelectorAll(
                        '[data-tid="menur1j"]',
                    )

                    console.log(
                        `[TEAMS-DEBUG] Old interface: ${oldInterfaceElements.length} elements`,
                    )
                    console.log(
                        `[TEAMS-DEBUG] New interface: ${newInterfaceElements.length} elements`,
                    )
                    console.log(
                        `[TEAMS-DEBUG] Live elements: ${liveElements.length} elements`,
                    )

                    // use the interface with participants - EXACT SAME AS EXTENSION
                    const speakerElements =
                        oldInterfaceElements.length > 0
                            ? oldInterfaceElements
                            : newInterfaceElements.length > 0
                              ? newInterfaceElements
                              : liveElements

                    console.log(
                        `[TEAMS-DEBUG] Using ${speakerElements.length} speaker elements`,
                    )

                    // If no participants are found, return an empty array - EXACT SAME AS EXTENSION
                    if (speakerElements.length === 0) {
                        return []
                    }

                    const speakers = Array.from(speakerElements)
                        .filter((element) => {
                            // Filter out 0x0 phantom elements that cause duplicates
                            const htmlEl = element as HTMLElement
                            const width = htmlEl.clientWidth
                            const height = htmlEl.clientHeight
                            return width > 0 && height > 0
                        })
                        .map((element, index) => {
                            console.log(
                                `[TEAMS-DEBUG] Processing visible element ${index}`,
                            )

                            const htmlEl = element as HTMLElement
                            const speakerSize = `${htmlEl.clientWidth}x${htmlEl.clientHeight}`
                            console.log(
                                `[TEAMS-DEBUG] Element ${index} size: ${speakerSize} (data-tid="${element.getAttribute('data-tid')}")`,
                            )

                            if (element.hasAttribute('data-cid')) {
                                // old teams - EXACT SAME AS EXTENSION
                                const name = getParticipantName(element)
                                console.log(
                                    `[TEAMS-DEBUG] Old teams - found name of length: "${name.length}"`,
                                )
                                if (name !== '') {
                                    if (
                                        element
                                            .getAttribute('aria-label')
                                            ?.includes(', muted,')
                                    ) {
                                        return {
                                            name,
                                            id: 0,
                                            timestamp,
                                            isSpeaking: false,
                                        }
                                    } else {
                                        return {
                                            name,
                                            id: 0,
                                            timestamp,
                                            isSpeaking: checkIfSpeaking(
                                                element as HTMLElement,
                                            ),
                                        }
                                    }
                                }
                            } else if (
                                element.hasAttribute('data-tid') &&
                                element.getAttribute('data-tid') === 'menur1j'
                            ) {
                                //live platform: Handle live platform - EXACT SAME AS EXTENSION
                                const name =
                                    element
                                        .getAttribute('aria-label')
                                        ?.split(',')[0] || ''
                                console.log(
                                    `[TEAMS-DEBUG] Live platform - found name of length: "${name.length}"`,
                                )
                                if (name) {
                                    // Only process if we have a name
                                    const micIcon = element.querySelector(
                                        '[data-cid="roster-participant-muted"]',
                                    )
                                    const isMuted = micIcon ? true : false
                                    const voiceLevelIndicator =
                                        element.querySelector(
                                            '[data-tid="voice-level-stream-outline"]',
                                        )
                                    const isSpeaking =
                                        !isMuted && voiceLevelIndicator
                                            ? checkElementAndPseudo(
                                                  voiceLevelIndicator as HTMLElement,
                                              )
                                            : false

                                    return {
                                        name,
                                        id: 0,
                                        timestamp,
                                        isSpeaking,
                                    }
                                }
                            } else {
                                // new teams
                                const name = element.getAttribute('data-tid')
                                console.log(
                                    `[TEAMS-DEBUG] New teams - found name of length: "${name.length}"`,
                                )
                                if (name) {
                                    const micPath = element.querySelector(
                                        'g.ui-icon__outline path',
                                    )
                                    const isMuted =
                                        micPath
                                            ?.getAttribute('d')
                                            ?.startsWith('M12 5v4.879') || false
                                    const voiceLevelIndicator =
                                        element.querySelector(
                                            '[data-tid="voice-level-stream-outline"]',
                                        )
                                    const isSpeaking =
                                        voiceLevelIndicator && !isMuted
                                            ? checkElementAndPseudo(
                                                  voiceLevelIndicator as HTMLElement,
                                              )
                                            : false

                                    return {
                                        name,
                                        id: 0,
                                        timestamp,
                                        isSpeaking,
                                    }
                                }
                            }
                            // Log pour le débogage - EXACT SAME AS EXTENSION
                            console.debug(
                                '[Teams] Could not determine participant info for element:',
                                element,
                            )
                            return undefined // Explicitly return undefined for filtering
                        })
                        .filter(
                            (value): value is SpeakerData =>
                                value !== undefined,
                        )

                    console.log(
                        `[TEAMS-DEBUG] Found ${speakers.length} visible speakers:`,
                        speakers.map(
                            (s, index) =>
                                `Speaker ${index + 1} (speaking: ${s.isSpeaking})`,
                        ),
                    )

                    return speakers
                }

                // EXACT SAME helper functions as extension
                function checkIfSpeaking(element: HTMLElement): boolean {
                    let isSpeaking: boolean = checkElementAndPseudo(element)
                    if (!isSpeaking) {
                        element.querySelectorAll('*').forEach((child) => {
                            if (checkElementAndPseudo(child as HTMLElement)) {
                                isSpeaking = true
                            }
                        })
                    }
                    return isSpeaking
                }

                function checkElementAndPseudo(el: HTMLElement): boolean {
                    const style = window.getComputedStyle(el)
                    const beforeStyle = window.getComputedStyle(el, '::before')
                    const borderStyle = window.getComputedStyle(el)

                    // Old teams - EXACT SAME AS EXTENSION
                    if (
                        el.getAttribute('data-tid') ===
                        'participant-speaker-ring'
                    ) {
                        return parseFloat(style.opacity) === 1
                    }

                    // New teams - EXACT SAME AS EXTENSION
                    if (
                        el.getAttribute('data-tid') ===
                            'voice-level-stream-outline' &&
                        el.closest('[data-stream-type="Video"]')
                    ) {
                        const hasVdiFrameClass = el.classList.contains(
                            'vdi-frame-occlusion',
                        )
                        const borderColor =
                            beforeStyle.borderColor ||
                            beforeStyle.borderTopColor
                        const borderOpacity = parseFloat(beforeStyle.opacity)
                        return (
                            hasVdiFrameClass ||
                            (isBlueish(borderColor) && borderOpacity === 1)
                        )
                    }

                    // Live platform - EXACT SAME AS EXTENSION
                    if (
                        el.getAttribute('data-tid') ===
                            'voice-level-stream-outline' &&
                        window.location.href.includes('live')
                    ) {
                        const hasVdiFrameClass = el.classList.contains(
                            'vdi-frame-occlusion',
                        )
                        const borderOpacity =
                            parseFloat(beforeStyle.opacity) ||
                            parseFloat(borderStyle.opacity)
                        const borderColor =
                            beforeStyle.borderColor ||
                            beforeStyle.borderTopColor ||
                            borderStyle.borderColor
                        return (
                            hasVdiFrameClass ||
                            (isBlueish(borderColor) && borderOpacity === 1)
                        )
                    }

                    return false
                }

                function isBlueish(color: string): boolean {
                    // EXACT SAME AS EXTENSION
                    color = color.toLowerCase().trim()

                    let rgb: number[] | null = null

                    // Check and extract RGB values from hex format
                    if (color.startsWith('#')) {
                        // Handle short hex format (e.g., #fff)
                        if (color.length === 4) {
                            const r = parseInt(color[1] + color[1], 16)
                            const g = parseInt(color[2] + color[2], 16)
                            const b = parseInt(color[3] + color[3], 16)
                            rgb = [r, g, b]
                        }
                        // Handle long hex format (e.g., #ffffff)
                        else if (color.length === 7) {
                            const r = parseInt(color.slice(1, 3), 16)
                            const g = parseInt(color.slice(3, 5), 16)
                            const b = parseInt(color.slice(5, 7), 16)
                            rgb = [r, g, b]
                        }
                    } else {
                        // Try to extract RGB values from "rgb" or "rgba" format
                        const match = color.match(/\d+/g)
                        if (match && match.length >= 3) {
                            rgb = match.map(Number).slice(0, 3)
                        }
                    }

                    // Check if rgb is assigned and validate the blue dominance with stricter criteria
                    if (rgb && rgb.length === 3) {
                        const [r, g, b] = rgb
                        return (
                            b > 180 &&
                            b > r + 40 &&
                            b > g + 40 &&
                            r < 150 &&
                            g < 150
                        )
                    }
                    return false
                }

                function getParticipantName(name: Element): string {
                    // EXACT SAME AS EXTENSION
                    const nameBlackList = ['Content shared by', 'Leaving...']
                    const toSplitOn = [
                        ', video is on,',
                        ', muted,',
                        ', Context menu is available',
                        '(Unverified)',
                        'left the meeting',
                        'Leaving...',
                    ]

                    const ariaLabel = name.getAttribute('aria-label') || ''
                    let result: string = ariaLabel

                    for (const blackListed of nameBlackList) {
                        if (ariaLabel.includes(blackListed)) {
                            return ''
                        }
                    }

                    for (const splitTerm of toSplitOn) {
                        result = result.split(splitTerm)[0]
                    }

                    return result
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

                        // Filter out bot - EXACT SAME AS EXTENSION
                        currentSpeakersList = currentSpeakersList.filter(
                            (speaker) => speaker.name !== botName,
                        )

                        let new_speakers = new Map(
                            currentSpeakersList.map((elem) => [
                                elem.name,
                                elem.isSpeaking,
                            ]),
                        )

                        // Send data only when a speakers change state is detected - EXACT SAME AS EXTENSION
                        if (!areMapsEqual(CUR_SPEAKERS, new_speakers)) {
                            console.log(
                                `[TEAMS-DEBUG-CHANGE] Speakers changed - ${currentSpeakersList.length} total`,
                            )

                            // Simple speaker status logs
                            currentSpeakersList.forEach((speaker, index) => {
                                console.log(
                                    `[TEAMS-DEBUG-SPEAKER] Speaker ${index + 1} : ${speaker.isSpeaking}`,
                                )
                            })

                            // CRITICAL: Call the callback
                            console.log(
                                '[TEAMS-DEBUG-CALLBACK] Calling teamsSpekersChanged',
                            )
                            await (window as any).teamsSpekersChanged(
                                currentSpeakersList,
                            )

                            // CRITICAL: Update current speakers AFTER calling callback
                            CUR_SPEAKERS.clear()
                            new_speakers.forEach((value, key) =>
                                CUR_SPEAKERS.set(key, value),
                            )
                            console.log(
                                '[TEAMS-DEBUG-UPDATE] Speakers state updated',
                            )
                        }
                    } catch (e) {
                        console.error('[Teams] Error in checkSpeakers:', e)
                    }
                }

                // EXACT SAME MutationObserver setup as extension
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

                // EXACT SAME setupMutationObserver as extension
                async function setupMutationObserver(): Promise<boolean> {
                    try {
                        const documentRoot = getDocumentRoot()

                        MUTATION_OBSERVER!.disconnect()
                        MUTATION_OBSERVER!.observe(documentRoot, {
                            attributes: true,
                            childList: true,
                            subtree: true,
                            attributeFilter: ['style', 'class'],
                        })

                        console.log(
                            '[Teams-Browser] Mutation observer successfully set up',
                        )
                        lastMutationTime = Date.now()
                        return true
                    } catch (e) {
                        console.warn(
                            '[Teams-Browser] Failed to setup mutation observer:',
                            e,
                        )
                        return false
                    }
                }

                // EXACT SAME observeSpeakers logic as extension - NO DUPLICATION
                async function observeSpeakers() {
                    try {
                        // EXACT SAME as extension: Initial check for speakers already talking
                        // But only send if isSpeaking === true (like extension)
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
                                `[TEAMS-DEBUG-INIT] Found ${currentSpeakersList.length} speakers already talking`,
                            )
                            await (window as any).teamsSpekersChanged(
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

                        // EXACT SAME periodic check as extension
                        periodicCheck = setInterval(async () => {
                            if (document.visibilityState !== 'hidden') {
                                if (
                                    Date.now() - lastMutationTime >
                                    freezeTimeout
                                ) {
                                    console.warn(
                                        `[Teams-Browser] No mutations detected for ${freezeTimeout / 1000}s, resetting observer`,
                                    )
                                    await setupMutationObserver()
                                }
                                checkSpeakers()
                            }
                        }, checkInterval)

                        // Cleanup function
                        ;(window as any).teamsObserverCleanup = () => {
                            console.log('[Teams-Browser] Cleaning up observer')
                            if (MUTATION_OBSERVER) {
                                MUTATION_OBSERVER.disconnect()
                            }
                            if (checkSpeakersTimeout) {
                                clearTimeout(checkSpeakersTimeout)
                            }
                            if (periodicCheck) {
                                clearInterval(periodicCheck)
                            }
                        }

                        // CRITICAL: Initial check like in extension
                        checkSpeakers()

                        console.log(
                            '[Teams-Browser] Observer setup complete - EXACT EXTENSION LOGIC',
                        )
                    } catch (e) {
                        console.warn(
                            '[Teams-Browser] Failed to initialize observer:',
                            e,
                        )
                        setTimeout(observeSpeakers, 5000)
                    }
                }

                // Initialize - EXACT SAME AS EXTENSION
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
        console.log('[Teams] ✅ Observer started successfully')

        // Capture DOM state after Speakers Observer is started
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        await htmlSnapshot.captureSnapshot(
            this.page,
            'teams_speaker_observer_started',
        )
    }

    public stopObserving(): void {
        if (!this.isObserving) {
            return
        }

        console.log('[Teams] Stopping observation...')

        this.page
            ?.evaluate(() => {
                if ((window as any).teamsObserverCleanup) {
                    ;(window as any).teamsObserverCleanup()
                }
            })
            .catch((e) => console.error('[Teams] Error cleaning up:', e))

        this.isObserving = false
        console.log('[Teams] ✅ Observer stopped')
    }
}
