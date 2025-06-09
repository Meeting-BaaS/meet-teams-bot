import { RecordingMode, SpeakerData } from '../observeSpeakers'

export const SPEAKER_LATENCY = 0 // ms

let lastValidSpeakers: SpeakerData[] = []
let lastValidSpeakerCheck = Date.now()
const FREEZE_TIMEOUT = 30000 // 30 seconds

// Cache selectors to avoid repeated DOM queries
let cachedParticipantsList: Element | null = null
let lastParticipantsListCheck = 0
const PARTICIPANTS_LIST_CACHE_DURATION = 1000 // 1 second cache - more conservative

export async function getSpeakerRootToObserve(
    recordingMode: RecordingMode,
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
            const filteredDivs = Array.from(allDivs).filter((div) => {
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
            })
            
            // We no longer remove these divs to avoid disrupting the interface
            // filteredDivs.forEach((div) => {
            //     div.remove()
            // })

            // Observe the entire document - keep original logic that works
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
            console.error('Error in getSpeakerRootToObserve:', error)
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

// Fonction pour observer toutes les iframes existantes et futures
export function observeIframes(callback: (iframe: HTMLIFrameElement) => void) {
    // Observer les iframes existantes
    document.querySelectorAll('iframe').forEach(iframe => {
        callback(iframe);
    });

    // Observe for new iframes
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeName === 'IFRAME') {
                    callback(node as HTMLIFrameElement);
                }
                // Look for iframes inside added nodes
                if (node.nodeType === Node.ELEMENT_NODE) {
                    (node as Element).querySelectorAll('iframe').forEach(iframe => {
                        callback(iframe);
                    });
                }
            });
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    return observer;
}

// Helper to get a document from an iframe
export function getIframeDocument(iframe: HTMLIFrameElement): Document | null {
    try {
        // Check if the iframe is accessible (same origin)
        return iframe.contentDocument || iframe.contentWindow?.document || null;
    } catch (error) {
        // If the iframe is cross-origin we cannot access it
        console.log('Cannot access iframe content (likely cross-origin):', error);
        return null;
    }
}

export function getSpeakerFromDocument(
    _recordingMode: RecordingMode,
    timestamp: number,
): SpeakerData[] {
    try {
        // Check if the page is frozen
        const currentTime = Date.now()
        if (currentTime - lastValidSpeakerCheck > FREEZE_TIMEOUT) {
            return []
        }

        // Query participants list every time to ensure freshness
        const participantsList = document.querySelector("[aria-label='Participants']")
        if (!participantsList) {
            lastValidSpeakers = []
            return [] // Real case of 0 participants
        }

        const participantItems = participantsList.querySelectorAll('[role="listitem"]')

        if (!participantItems || participantItems.length === 0) {
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
            const ariaLabel = item.getAttribute('aria-label')?.trim()

            if (!ariaLabel) continue

            // Check if this element is "Merged audio"
            const isMergedAudio = ariaLabel === 'Merged audio'

            // Get the cohort id for merged groups
            let cohortId: string | null = null
            if (isMergedAudio) {
                // Look for the cohort id in the parent element
                const cohortElement = item.closest('[data-cohort-id]')
                if (cohortElement) {
                    cohortId = cohortElement.getAttribute('data-cohort-id')
                }

                // Check if the merged audio is speaking - keep original logic
                const speakingIndicators = Array.from(
                    item.querySelectorAll('*'),
                ).filter((elem) => {
                    const color = getComputedStyle(elem).backgroundColor
                    return (
                        color === 'rgba(26, 115, 232, 0.9)' ||
                        color === 'rgb(26, 115, 232)'
                    )
                })

                // Also check for the unmuted microphone icon
                const unmutedMicImg = item.querySelector('img[src*="mic_unmuted"]')

                const isSpeaking = speakingIndicators.length > 0 || !!unmutedMicImg

                // Initialize the merged group
                if (cohortId) {
                    mergedGroups.set(cohortId, {
                        isSpeaking: isSpeaking,
                        members: [],
                    })
                }
            }

            // Check if this participant is part of a merged audio group
            const isInMergedAudio = !!item.querySelector('[aria-label="Adaptive audio group"]')
            let participantCohortId: string | null = null

            if (isInMergedAudio) {
                // Look for the cohort id in the parent element
                const cohortElement = item.closest('[data-cohort-id]')
                if (cohortElement) {
                    participantCohortId = cohortElement.getAttribute('data-cohort-id')
                }

                // Add this participant to the matching merged group
                if (participantCohortId && mergedGroups.has(participantCohortId)) {
                    mergedGroups.get(participantCohortId)!.members.push(ariaLabel)
                }
            }

            // Add the participant to our map only if not in a merged group
            // or if it is the "Merged audio" entry itself
            if (isMergedAudio || !isInMergedAudio) {
                const uniqueKey = isMergedAudio && cohortId ? `Merged audio_${cohortId}` : ariaLabel

                if (!uniqueParticipants.has(uniqueKey)) {
                    uniqueParticipants.set(uniqueKey, {
                        name: ariaLabel,
                        isSpeaking: false,
                        isPresenting: false,
                        isInMergedAudio: isMergedAudio,
                        cohortId: isMergedAudio ? cohortId : null,
                    })
                }

                const participant = uniqueParticipants.get(uniqueKey)!

                // Check if the participant is presenting - keep original logic
                const allDivs = Array.from(item.querySelectorAll('div'))
                const isPresenting = allDivs.some((div) => {
                    const text = div.textContent?.trim()
                    return text === 'Presentation'
                })

                if (isPresenting) {
                    participant.isPresenting = true
                }

                // Check speaking indicators - keep original logic but with small optimization
                const speakingIndicators = Array.from(
                    item.querySelectorAll('*'),
                ).filter((elem) => {
                    const color = getComputedStyle(elem).backgroundColor
                    return (
                        color === 'rgba(26, 115, 232, 0.9)' ||
                        color === 'rgb(26, 115, 232)'
                    )
                })

                // Process indicators with early exit optimization
                for (const indicator of speakingIndicators) {
                    const backgroundElement = indicator.children[1]
                    if (backgroundElement) {
                        const backgroundPosition = getComputedStyle(backgroundElement).backgroundPositionX
                        if (backgroundPosition !== '0px') {
                            participant.isSpeaking = true
                            break // Exit early once found - small optimization
                        }
                    }
                }

                // Update the map with the potentially modified data
                uniqueParticipants.set(uniqueKey, participant)
            }
        }

        // Replace merged group names with member names
        for (const [key, participant] of uniqueParticipants.entries()) {
            if (
                participant.name === 'Merged audio' &&
                participant.cohortId &&
                mergedGroups.has(participant.cohortId)
            ) {
                const members = mergedGroups.get(participant.cohortId)!.members
                if (members.length > 0) {
                    participant.name = members.join(', ')
                    uniqueParticipants.set(key, participant)
                }
            }
        }

        // Build the final participant list
        const speakers = Array.from(uniqueParticipants.values()).map(
            (participant) => ({
                name: participant.name,
                id: 0,
                timestamp,
                isSpeaking: participant.isSpeaking,
            }),
        )

        lastValidSpeakers = speakers
        lastValidSpeakerCheck = currentTime
        return speakers
    } catch (e) {
        return lastValidSpeakers
    }
}

// export function findAllAttendees(): string[] {
//     let images = document.querySelectorAll('img')

//     let participants = Array.from(images).filter(
//         (img) => img.clientWidth === 32 && img.clientHeight === 32,
//     )
//     const names: string[] = []
//     // https://www.lifewire.com/change-your-name-on-google-meet-5112077
//     for (const participant of participants) {
//         let currentElement: any = participant

//         while (currentElement) {
//             // Check if this parent has a child span
//             const span = currentElement.querySelector('span')
//             if (span) {
//                 // Found a parent with a child span
//                 names.push(span.innerText)
//                 break
//             }

//             // Move to the next parent
//             currentElement = currentElement.parentElement
//         }
//     }
//     return names
// }

// In the function that initializes speaker observation
const iframeObserver = observeIframes((iframe) => {
    const iframeDoc = getIframeDocument(iframe);
    if (iframeDoc) {
        // Create a new observer for the iframe content
        const observer = new MutationObserver((mutations) => {
            // Same logic as the main observer
            // Process mutations to detect speaker changes
        });
        
        // Observe the iframe document with the same parameters
        observer.observe(iframeDoc, {
            attributes: true,
            characterData: false,
            childList: true,
            subtree: true,
            attributeFilter: ['class', 'aria-label'],
        });
    }
});

// Store this iframeObserver so it can be disconnected later if needed
