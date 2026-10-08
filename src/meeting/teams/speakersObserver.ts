import type { Page } from '@playwright/test'
import { HtmlSnapshotService } from '../../services/html-snapshot-service'
import type { RecordingMode } from '../../types'
import type { SpeakerData } from '../../speaker-id'
import { resolveTeamsTileName } from './participant-name'

declare global {
    interface Window {
        teamsObserverCleanup: () => void
        teamsSpeakersChanged: (speakers: SpeakerData[]) => void
    }
}

export class TeamsSpeakersObserver {
    private static bindings = new WeakMap<
        Page,
        {
            owner: TeamsSpeakersObserver | null
            ready: Promise<void>
        }
    >()
    private page: Page
    private recordingMode: RecordingMode
    private botName: string
    private onSpeakersChange: (speakers: SpeakerData[]) => void
    private isObserving = false
    private startup?: Promise<void>
    private generation = 0

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
        if (this.startup) return this.startup
        if (this.isObserving) {
            console.warn('[Teams] Already observing')
            return
        }

        const generation = ++this.generation
        const startup = this.initialize(generation).finally(() => {
            if (this.startup === startup) this.startup = undefined
        })
        this.startup = startup
        return startup
    }

    private async initialize(generation: number): Promise<void> {
        // Bind once per Page; retries and pause/resume replace the recipient,
        // not the Playwright binding (which survives document navigation).
        let binding = TeamsSpeakersObserver.bindings.get(this.page)
        if (!binding) {
            binding = { owner: this, ready: Promise.resolve() }
            const registered = binding
            TeamsSpeakersObserver.bindings.set(this.page, registered)
            registered.ready = this.page
                .exposeFunction(
                    'teamsSpeakersChanged',
                    async (speakers: SpeakerData[]) => {
                        await registered.owner?.onSpeakersChange(speakers)
                    },
                )
                .catch((error) => {
                    if (
                        TeamsSpeakersObserver.bindings.get(this.page) ===
                        registered
                    ) {
                        TeamsSpeakersObserver.bindings.delete(this.page)
                    }
                    throw error
                })
        }
        binding.owner = this
        await binding.ready
        if (generation !== this.generation)
            throw new Error('Observer startup cancelled')

        // Inject EXACT SAME LOGIC as extension but via Playwright
        await this.page.evaluate(
            async ({
                //botName, // COMMENTED OUT: Keep bot in speakers for consistency with network speaker separation
                speakerLatency,
                mutationDebounce,
                checkInterval,
                freezeTimeout,
                resolveTileNameSource,
            }) => {
                window.teamsObserverCleanup?.()
                console.log(
                    '[Teams-Browser] Setting up observation - EXACT EXTENSION LOGIC',
                )

                // EXACT SAME VARIABLES AS EXTENSION
                const CUR_SPEAKERS = new Map<string, string>()
                let checkSpeakersTimeout: NodeJS.Timeout | null = null
                let lastMutationTime = Date.now()
                let MUTATION_OBSERVER: MutationObserver | null = null
                let periodicCheck: NodeJS.Timeout | null = null
                let stopped = false
                const cleanup = () => {
                    stopped = true
                    MUTATION_OBSERVER?.disconnect()
                    if (checkSpeakersTimeout) clearTimeout(checkSpeakersTimeout)
                    if (periodicCheck) clearInterval(periodicCheck)
                }
                window.teamsObserverCleanup = cleanup

                // EXACT SAME getDocumentRoot as extension
                function getDocumentRoot(): Document {
                    for (const iframe of document.querySelectorAll('iframe')) {
                        try {
                            const doc =
                                iframe.contentDocument ||
                                iframe.contentWindow?.document
                            if (doc) {
                                return doc
                            }
                        } catch (_e) {
                            // Iframe access denied - cross-origin
                        }
                    }
                    return document
                }

                const resolveName = new Function(
                    `return ${resolveTileNameSource}`,
                )() as (parts: {
                    nametags?: Array<string | null | undefined>
                    dataTid?: string | null
                    ariaLabel?: string | null
                }) => string

                // Teams puts the display name on the tile's data-tid and nametag, and only
                // appends its account badges ("External unfamiliar") to aria-label.
                function resolveTileName(element: Element): string {
                    const nametags = [
                        ...element.querySelectorAll(
                            '[data-tid="participant-info-nametag"]',
                        ),
                    ].map((node) => node.textContent)
                    return resolveName({
                        nametags,
                        dataTid: element.getAttribute('data-tid'),
                        ariaLabel: element.getAttribute('aria-label'),
                    })
                }

                // ── Caption-derived speaking signal ────────────────────────────────
                // The current Teams client exposes NO per-participant speaking state in
                // the DOM: voice-level-stream-outline is an empty div with a constant
                // class list and data-is-speaking was removed. Live captions are the only
                // per-speaker signal left, and they survive server-mixed audio. We read
                // the caption list the client already renders and attribute the newest
                // entry to whichever known participant it names.
                //
                // Matching is done on the entry's text against the roster rather than on
                // an inner data-tid, so it does not break when Fluent rotates class or
                // tid hashes — the author name is the stable part.
                const CAPTION_SPEAKING_WINDOW_MS = 2500
                const captionSpeakingUntil = new Map<string, number>()
                let lastCaptionSignature = ''

                function captionListText(): string {
                    const documentRoot = getDocumentRoot()
                    const list =
                        documentRoot.querySelector(
                            '[data-tid="closed-caption-v2-virtual-list-content"]',
                        ) ||
                        documentRoot.querySelector(
                            '[data-tid="closed-caption-renderer-wrapper"]',
                        ) ||
                        documentRoot.querySelector(
                            '[aria-label="Live Captions"]',
                        )
                    return list instanceof HTMLElement
                        ? list.innerText || list.textContent || ''
                        : ''
                }

                // Refresh the caption-derived speaking set. Called once per collection
                // pass so every tile in that pass sees a consistent view.
                function refreshCaptionSpeaking(knownNames: string[]): void {
                    const text = captionListText()
                    if (!text || text === lastCaptionSignature) return
                    lastCaptionSignature = text
                    // The caption list renders several recent entries, each
                    // labelled with its author, so two or three PREVIOUS speakers
                    // sit in the tail too. Marking every name found there reports
                    // them all as speaking at once and turns sequential speech
                    // into concurrent speakers. Only the entry closest to the end
                    // — the newest one — is currently being spoken, so attribute
                    // the window to that single author.
                    const tail = text.slice(-400)
                    let newestName = ''
                    let newestAt = -1
                    for (const name of knownNames) {
                        if (!name) continue
                        // Unanchored substring search misattributes when one name
                        // contains another ("Jon" inside "Bob", which return the
                        // same lastIndexOf and let the shorter name win on the
                        // tie). Require a non-word character (or end of text) after
                        // the match so an embedded name does not match, and on a
                        // genuine tie prefer the LONGER name.
                        let at = -1
                        let from = tail.length
                        while (from >= 0) {
                            const found = tail.lastIndexOf(name, from)
                            if (found === -1) break
                            const after = tail.charAt(found + name.length)
                            if (after === '' || /[^\w]/.test(after)) {
                                at = found
                                break
                            }
                            from = found - 1
                        }
                        if (
                            at > newestAt ||
                            (at === newestAt && name.length > newestName.length)
                        ) {
                            newestAt = at
                            newestName = name
                        }
                    }
                    if (newestName) {
                        captionSpeakingUntil.set(
                            newestName,
                            Date.now() + CAPTION_SPEAKING_WINDOW_MS,
                        )
                    }
                }

                function captionSaysSpeaking(name: string): boolean {
                    const until = captionSpeakingUntil.get(name)
                    if (until == null) return false
                    if (until <= Date.now()) {
                        captionSpeakingUntil.delete(name)
                        return false
                    }
                    return true
                }

                // Turn on live captions so the signal above exists at all. Idempotent and
                // best-effort: without the network interceptor injected, nothing else
                // enables them, and this path has to stand alone.
                let captionsRequested = false
                // Bound the DOM caption activation. Each pass through the More →
                // Language and speech menu counts as an attempt BEFORE clicking,
                // and attempts are spaced out, so a client build where the
                // control never appears does not click through the menu forever.
                let captionAttempts = 0
                let lastCaptionAttemptAt = 0
                const CAPTION_MAX_ATTEMPTS = 8
                const CAPTION_RETRY_MS = 3000
                function ensureCaptionsOn(): void {
                    // Node-side pause only stops forwarding; the browser's
                    // caption gate still runs and must remain the sole owner.
                    const network = window as Window & {
                        __teamsNetworkInterceptorInitialized?: boolean
                        __teamsNetworkInterceptorStopped?: boolean
                        __teamsStopNetworkInterception?: () => void
                    }
                    if (
                        network.__teamsNetworkInterceptorInitialized === true &&
                        typeof network.__teamsStopNetworkInterception ===
                            'function' &&
                        network.__teamsNetworkInterceptorStopped !== true
                    )
                        return
                    if (captionsRequested) return
                    try {
                        const documentRoot = getDocumentRoot()
                        // Latch ONLY when the renderer is actually mounted —
                        // captions are truly flowing. Latching on a click (below)
                        // would kill the fallback whenever the click did not
                        // mount the renderer, which Teams does not guarantee.
                        if (
                            documentRoot.querySelector(
                                '[data-tid="closed-caption-renderer-wrapper"]',
                            )
                        ) {
                            captionsRequested = true
                            return
                        }
                        // Bound the clicking: give up after the cap, and space
                        // attempts out so we do not walk the menu every pass.
                        if (captionAttempts >= CAPTION_MAX_ATTEMPTS) return
                        if (
                            Date.now() - lastCaptionAttemptAt <
                            CAPTION_RETRY_MS
                        )
                            return
                        captionAttempts++
                        lastCaptionAttemptAt = Date.now()
                        // The caption toggle is not on the toolbar — it lives
                        // under More → Language and speech, so the submenu has to
                        // be opened first and the button looked for on a later
                        // pass once it renders.
                        const button =
                            documentRoot.querySelector(
                                '#closed-captions-button',
                            ) ||
                            documentRoot.querySelector(
                                '[data-tid="closed-captions-button"]',
                            ) ||
                            documentRoot.querySelector(
                                '[data-tid="call-captions-button"]',
                            )
                        if (button instanceof HTMLElement) {
                            button.click()
                            // Do NOT latch captionsRequested here: the click may
                            // not mount the renderer. The renderer check above
                            // latches once captions actually flow.
                            console.log(
                                '[Teams-Browser] live captions toggle clicked (awaiting renderer)',
                            )
                            return
                        }
                        const languageAndSpeech =
                            documentRoot.querySelector(
                                '[data-tid="language-and-speech-button"]',
                            ) ||
                            documentRoot.querySelector(
                                '[id="language-and-speech-button"]',
                            )
                        if (languageAndSpeech instanceof HTMLElement) {
                            languageAndSpeech.click()
                            return
                        }
                        const moreButton =
                            documentRoot.querySelector(
                                '[data-tid="callingButtons-showMoreBtn"]',
                            ) ||
                            documentRoot.querySelector(
                                '[id="callingButtons-showMoreBtn"]',
                            )
                        if (moreButton instanceof HTMLElement)
                            moreButton.click()
                    } catch (_e) {
                        // control absent or not clickable — leave captions off
                    }
                }

                // EXACT SAME getSpeakerFromDocument as extension + DEBUG
                function getSpeakerFromDocument(
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

                    // Captions are the only per-speaker signal this client exposes, so make
                    // sure they are on and refresh the derived speaking set once per pass
                    // (before the tiles below read it, so they all see the same view).
                    ensureCaptionsOn()
                    const knownNames: string[] = []
                    speakerElements.forEach((el) => {
                        const n = resolveTileName(el)
                        if (n) knownNames.push(n)
                    })
                    refreshCaptionSpeaking(knownNames)
                    console.log(
                        `[TEAMS-DEBUG] caption-derived speakers: ${
                            knownNames
                                .filter((n) => captionSaysSpeaking(n))
                                .join(', ') || 'none'
                        }`,
                    )

                    const speakers = Array.from(speakerElements)
                        .filter((element) => {
                            // Filter out 0x0 phantom elements that cause duplicates
                            const htmlEl = element as HTMLElement
                            const width = htmlEl.clientWidth
                            const height = htmlEl.clientHeight
                            return width > 0 && height > 0
                        })
                        .map((element, index): SpeakerData | undefined => {
                            console.log(
                                `[TEAMS-DEBUG] Processing visible element ${index}`,
                            )

                            const idHolder =
                                element.closest('[data-participant-id]') ??
                                element.querySelector('[data-participant-id]')
                            const deviceId =
                                idHolder?.getAttribute('data-participant-id') ??
                                undefined
                            const isSelf =
                                element.getAttribute('data-is-self') ===
                                    'true' ||
                                element.getAttribute('data-tid') ===
                                    'self-video' ||
                                Array.from(
                                    element.querySelectorAll('span'),
                                ).some((span) =>
                                    /^(?:\(You\)|You)$/.test(
                                        span.textContent?.trim() ?? '',
                                    ),
                                )
                            const htmlEl = element as HTMLElement
                            const speakerSize = `${htmlEl.clientWidth}x${htmlEl.clientHeight}`
                            console.log(
                                `[TEAMS-DEBUG] Element ${index} size: ${speakerSize} (data-tid="${element.getAttribute('data-tid')}")`,
                            )

                            if (element.hasAttribute('data-cid')) {
                                // old teams - EXACT SAME AS EXTENSION
                                const name = isBlacklistedTile(element)
                                    ? ''
                                    : resolveTileName(element)
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
                                            deviceId,
                                            isSelf,
                                            isSpeaking: false,
                                        }
                                    }
                                    return {
                                        name,
                                        id: 0,
                                        timestamp,
                                        deviceId,
                                        isSelf,
                                        isSpeaking: checkIfSpeaking(
                                            element as HTMLElement,
                                        ),
                                    }
                                }
                            } else if (
                                element.hasAttribute('data-tid') &&
                                element.getAttribute('data-tid') === 'menur1j'
                            ) {
                                //live platform: Handle live platform - EXACT SAME AS EXTENSION
                                const name = resolveTileName(element)
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
                                        deviceId,
                                        isSelf,
                                        isSpeaking,
                                    }
                                }
                            } else {
                                // new teams (v2): tiles are [data-stream-type="Video"].
                                // aria-label is ABSENT on the current client — the display name is
                                // on data-tid ("Alice", "Bob (Guest)"). Reading only
                                // aria-label skipped every tile, so the observer reported zero
                                // participants and the timeline came back empty.
                                // data-tid can hold a raw email on some builds, which must never be
                                // used as a display name (PII) — so take it only when it does not
                                // look like an address.
                                const name = resolveTileName(element)
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
                                    // v2 used to expose the active speaker via data-is-speaking here.
                                    // On the current client that attribute is gone and the outline is
                                    // an empty div with a constant class list, so this check can only
                                    // ever return false — the captions fallback below is what actually
                                    // carries speech. Kept for older clients that still populate it.
                                    const speakingAttr =
                                        voiceLevelIndicator?.getAttribute(
                                            'data-is-speaking',
                                        )
                                    const domSpeaking =
                                        voiceLevelIndicator && !isMuted
                                            ? speakingAttr != null
                                                ? speakingAttr === 'true'
                                                : checkElementAndPseudo(
                                                      voiceLevelIndicator as HTMLElement,
                                                  )
                                            : false

                                    return {
                                        name,
                                        id: 0,
                                        timestamp,
                                        deviceId,
                                        isSelf,
                                        isSpeaking:
                                            domSpeaking ||
                                            (!isMuted &&
                                                captionSaysSpeaking(name)),
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
                        return Number.parseFloat(style.opacity) === 1
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
                        const borderOpacity = Number.parseFloat(
                            beforeStyle.opacity,
                        )
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
                            Number.parseFloat(beforeStyle.opacity) ||
                            Number.parseFloat(borderStyle.opacity)
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
                    const colorLower = color.toLowerCase().trim()

                    let rgb: number[] | null = null

                    // Check and extract RGB values from hex format
                    if (colorLower.startsWith('#')) {
                        // Handle short hex format (e.g., #fff)
                        if (colorLower.length === 4) {
                            const r = Number.parseInt(
                                colorLower[1] + colorLower[1],
                                16,
                            )
                            const g = Number.parseInt(
                                colorLower[2] + colorLower[2],
                                16,
                            )
                            const b = Number.parseInt(
                                colorLower[3] + colorLower[3],
                                16,
                            )
                            rgb = [r, g, b]
                        }
                        // Handle long hex format (e.g., #ffffff)
                        else if (colorLower.length === 7) {
                            const r = Number.parseInt(
                                colorLower.slice(1, 3),
                                16,
                            )
                            const g = Number.parseInt(
                                colorLower.slice(3, 5),
                                16,
                            )
                            const b = Number.parseInt(
                                colorLower.slice(5, 7),
                                16,
                            )
                            rgb = [r, g, b]
                        }
                    } else {
                        // Try to extract RGB values from "rgb" or "rgba" format
                        const match = colorLower.match(/\d+/g)
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

                // Tiles that show content or a leaving participant carry no usable name.
                function isBlacklistedTile(element: Element): boolean {
                    const ariaLabel = element.getAttribute('aria-label') || ''
                    return ['Content shared by', 'Leaving...'].some((entry) =>
                        ariaLabel.includes(entry),
                    )
                }

                // SHARED CRITICAL LOGIC from speakersUtils
                function areMapsEqual<K, V>(
                    map1: Map<K, V>,
                    map2: Map<K, V>,
                ): boolean {
                    if (map1.size !== map2.size) {
                        return false
                    }
                    for (const [key, value] of map1) {
                        if (!map2.has(key) || map2.get(key) !== value) {
                            return false
                        }
                    }
                    return true
                }

                // SHARED CRITICAL checkSpeakers logic
                let lastHeartbeat = 0
                async function checkSpeakers(initial = false) {
                    if (stopped) return
                    try {
                        const timestamp = Date.now() - speakerLatency
                        const currentSpeakersList =
                            getSpeakerFromDocument(timestamp)

                        // Filter out bot - EXACT SAME AS EXTENSION
                        // COMMENTED OUT: Keep bot in speakers for consistency with network speaker separation
                        // currentSpeakersList = currentSpeakersList.filter((speaker) => speaker.name !== botName)

                        const new_speakers = new Map(
                            currentSpeakersList.map((elem) => [
                                elem.deviceId ?? elem.name,
                                JSON.stringify([
                                    elem.name,
                                    elem.isSpeaking,
                                    elem.deviceId ?? null,
                                    elem.isSelf === true,
                                ]),
                            ]),
                        )

                        // Send data only when a speakers change state is detected - EXACT SAME AS EXTENSION
                        if (
                            !areMapsEqual(CUR_SPEAKERS, new_speakers) ||
                            Date.now() - lastHeartbeat >= 5000
                        ) {
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
                                '[TEAMS-DEBUG-CALLBACK] Calling teamsSpeakersChanged',
                            )
                            await window.teamsSpeakersChanged(
                                currentSpeakersList,
                            )
                            lastHeartbeat = Date.now()

                            // CRITICAL: Update current speakers AFTER calling callback
                            CUR_SPEAKERS.clear()
                            new_speakers.forEach((value, key) => {
                                CUR_SPEAKERS.set(key, value)
                            })
                            console.log(
                                '[TEAMS-DEBUG-UPDATE] Speakers state updated',
                            )
                        }
                    } catch (e) {
                        console.error('[Teams] Error in checkSpeakers:', e)
                        if (initial) throw e
                    }
                }

                // EXACT SAME MutationObserver setup as extension
                MUTATION_OBSERVER = new MutationObserver(() => {
                    if (stopped) return
                    if (checkSpeakersTimeout !== null) {
                        clearTimeout(checkSpeakersTimeout)
                    }

                    lastMutationTime = Date.now()

                    checkSpeakersTimeout = setTimeout(() => {
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
                            attributeFilter: [
                                'style',
                                'class',
                                'aria-label',
                                'data-participant-id',
                                'data-is-self',
                                'data-is-speaking',
                            ],
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
                        if (!(await setupMutationObserver())) {
                            throw new Error(
                                'Teams mutation observer initialization failed',
                            )
                        }
                        await checkSpeakers(true)
                        if (stopped) return

                        // EXACT SAME periodic check as extension
                        periodicCheck = setInterval(async () => {
                            if (stopped) return
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

                        console.log(
                            '[Teams-Browser] Observer setup complete - EXACT EXTENSION LOGIC',
                        )
                    } catch (e) {
                        console.warn(
                            '[Teams-Browser] Failed to initialize observer:',
                            e,
                        )
                        cleanup()
                        throw e
                    }
                }

                // Initialize - EXACT SAME AS EXTENSION
                await observeSpeakers()
            },
            {
                recordingMode: this.recordingMode,
                botName: this.botName,
                speakerLatency: this.SPEAKER_LATENCY,
                mutationDebounce: this.MUTATION_DEBOUNCE,
                checkInterval: this.CHECK_INTERVAL,
                freezeTimeout: this.FREEZE_TIMEOUT,
                // One implementation, unit-tested in participant-name.test.ts.
                resolveTileNameSource: resolveTeamsTileName.toString(),
            },
        )

        if (generation !== this.generation)
            throw new Error('Observer startup cancelled')
        this.isObserving = true
        console.log('[Teams] ✅ Observer started successfully')

        // Capture DOM state after Speakers Observer is started
        try {
            await HtmlSnapshotService.getInstance().captureSnapshot(
                this.page,
                'teams_speaker_observer_started',
            )
        } catch (error) {
            console.warn('[Teams] Observer snapshot failed:', error)
        }
    }

    public async stopObserving(): Promise<void> {
        ++this.generation
        this.isObserving = false
        const binding = TeamsSpeakersObserver.bindings.get(this.page)
        if (binding?.owner === this) binding.owner = null
        await this.startup?.catch(() => {})
        // An old instance must not stop a replacement observer on this Page.
        if (TeamsSpeakersObserver.bindings.get(this.page)?.owner) return
        await this.page
            .evaluate(() => {
                if (window.teamsObserverCleanup) {
                    window.teamsObserverCleanup()
                }
            })
            .catch((e) => console.error('[Teams] Error cleaning up:', e))

        console.log('[Teams] ✅ Observer stopped')
    }
}
