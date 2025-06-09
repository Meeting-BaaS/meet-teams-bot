import * as R from 'ramda'
import * as MeetProvider from './observeSpeakers/meet'
import * as TeamsProvider from './observeSpeakers/teams'

import { ApiService } from './api'

export type SpeakerData = {
    name: string
    id: number
    timestamp: number
    isSpeaking: boolean
}

declare var BOT_NAME: string
declare var MEETING_PROVIDER: string
declare var RECORDING_MODE: RecordingMode
export type RecordingMode = 'speaker_view' | 'gallery_view' | 'audio_only'

type Provider = {
    LATENCY: number
    // findAllAttendees: () => string[]
    getSpeakerFromDocument: (arg0: RecordingMode, arg1: number) => SpeakerData[]
    getSpeakerRootToObserve: (
        arg0: RecordingMode,
    ) => Promise<[Node, MutationObserverInit] | undefined>
}

let PROVIDER: Provider | null = null
var CUR_SPEAKERS: Map<string, boolean> = new Map()

setMeetingProvider()
observeSpeakers()
checkSpeakers()

function setMeetingProvider() {
    if (MEETING_PROVIDER === 'Teams') {
        PROVIDER = {
            LATENCY: TeamsProvider.SPEAKER_LATENCY,
            // findAllAttendees: TeamsProvider.findAllAttendees,
            getSpeakerFromDocument: TeamsProvider.getSpeakerFromDocument,
            getSpeakerRootToObserve: TeamsProvider.getSpeakerRootToObserve,
        }
    } else if (MEETING_PROVIDER === 'Meet') {
        PROVIDER = {
            LATENCY: MeetProvider.SPEAKER_LATENCY,
            // findAllAttendees: MeetProvider.findAllAttendees,
            getSpeakerFromDocument: MeetProvider.getSpeakerFromDocument,
            getSpeakerRootToObserve: MeetProvider.getSpeakerRootToObserve,
        }
    } else {
        PROVIDER = null
    }
}

async function checkSpeakers() {
    try {
        const timestamp = Date.now() - PROVIDER!.LATENCY
        let currentSpeakersList: SpeakerData[] =
            PROVIDER!.getSpeakerFromDocument(RECORDING_MODE, timestamp)

        // BOT_NAME is not a speaker and we havent in Teams so we remove it from meet also
        //TODO: work on bot speaking detection for speaking bot
        currentSpeakersList = currentSpeakersList.filter(
            (speaker) => speaker.name !== BOT_NAME,
        )

        let new_speakers = new Map(
            currentSpeakersList.map((elem) => [elem.name, elem.isSpeaking]),
        )
        function areMapsEqual<K, V>(map1: Map<K, V>, map2: Map<K, V>): boolean {
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
        // Send data only when a speakers change state is detected
        if (!areMapsEqual(CUR_SPEAKERS, new_speakers)) {
            await ApiService.sendMessageToRecordingServer(
                'SPEAKERS',
                currentSpeakersList,
            ).catch((e) => {
                // console.error('Catch on send currentSpeakersList :', e)
            })
            CUR_SPEAKERS = new_speakers
        }
    } catch (e) {
        // console.error('Catch on MutationObserver :', e)
    }
}

let checkSpeakersTimeout: number | null = null
// Debounce delay optimized to 150ms for good balance between reactivity and CPU usage
// This reduces CPU usage while maintaining reasonable responsiveness
const MUTATION_DEBOUNCE = 150

// Track the last time a DOM mutation was detected to implement intelligent observer reset logic
let lastMutationTime = Date.now()

var MUTATION_OBSERVER = new MutationObserver(function () {
    if (checkSpeakersTimeout !== null) {
        window.clearTimeout(checkSpeakersTimeout)
    }

    // Update the last mutation time whenever a mutation is detected
    lastMutationTime = Date.now()

    checkSpeakersTimeout = window.setTimeout(() => {
        checkSpeakers()
        checkSpeakersTimeout = null
    }, MUTATION_DEBOUNCE)
})

// Observe Speakers mutation
async function observeSpeakers() {
    try {
        const currentSpeakersList: SpeakerData[] = R.filter(
            (u: SpeakerData) => u.name !== BOT_NAME && u.isSpeaking == true,
            PROVIDER!.getSpeakerFromDocument(
                RECORDING_MODE,
                Date.now() - PROVIDER!.LATENCY,
            ),
        )

        if (currentSpeakersList.length > 0) {
            await ApiService.sendMessageToRecordingServer(
                'SPEAKERS',
                currentSpeakersList,
            ).catch((e) => {})
        }
    } catch (e) {}

    try {
        if (!PROVIDER) {
            console.warn('Provider is not initialized')
            return
        }

        await setupMutationObserver()

        // Set up periodic check to verify and potentially reset the mutation observer
        setInterval(async () => {
            if (document.visibilityState !== 'hidden') {
                // Check if mutations have stopped being detected, indicating potential DOM changes
                // that require observer reset. Threshold set to 15s for balanced performance
                if (Date.now() - lastMutationTime > 15000) {
                    console.warn(
                        'No mutations detected for 15 seconds, resetting observer',
                    )
                    await setupMutationObserver()
                }

                // Fallback speaker detection with balanced frequency
                // Interval set to 15s for good balance between accuracy and performance
                checkSpeakers()
            }
        }, 15000) // 15 seconds for balanced performance
    } catch (e) {
        console.warn('Failed to initialize observer:', e)
        // Retry after a delay
        setTimeout(observeSpeakers, 5000)
    }
}

// Extract the mutation observer setup into its own function
async function setupMutationObserver() {
    const observe_parameters = await PROVIDER!.getSpeakerRootToObserve(
        RECORDING_MODE,
    )

    if (!observe_parameters || !observe_parameters[0]) {
        console.warn('No valid root element to observe')
        return false
    }

    // Disconnect any existing observer before creating a new one
    MUTATION_OBSERVER.disconnect()
    MUTATION_OBSERVER.observe(observe_parameters[0], observe_parameters[1])
    console.log('Mutation observer successfully set up')

    // Reset the last mutation time when we set up a new observer
    lastMutationTime = Date.now()

    return true
}
