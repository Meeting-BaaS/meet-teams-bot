import * as fs from 'fs'

import { MeetingStateMachine } from './state-machine/machine'
import { Streaming } from './streaming'

import { enablePrintPageLogs } from './browser/page-logger'
import type { NetworkUser } from './meeting/teams/network-interception/types'
import { GLOBAL } from './singleton'
import { ParticipantState } from './state-machine/types'
import { SpeakerData } from './types'
import { uploadTranscriptTask } from './uploadTranscripts'
import { PathManager } from './utils/PathManager'

/** The placeholder every platform's interceptor falls back to before a roster lands. */
const UNKNOWN_SPEAKER = "Unknown"

/**
 * How long after the first network update an unresolved name is still assumed
 * to be a roster race rather than a genuinely nameless participant.
 */
const ROSTER_GRACE_MS = 15000

export class SpeakerManager {
    private static instance: SpeakerManager | null = null
    private currentSpeaker: SpeakerData | null = null
    private readonly PAUSE_BETWEEN_SENTENCES = 1000 // 1 second
    private lastSpeakerTime: number | null = null
    private lastCallbackTime: number | null = null // Track when we last received ANY callback
    // Best name seen so far per network device. Rosters arrive incrementally
    // and a later payload can omit a name that an earlier one carried; without
    // this, a participant flips back to "Unknown" mid-meeting.
    private deviceNames = new Map<string, string>()
    // When each device was first seen, so the roster-race grace window is
    // scoped to that participant rather than to the start of the meeting: a
    // participant joining at minute 20 races their own roster entry exactly
    // like the ones present at the start, and a meeting-wide anchor would
    // have expired long ago.
    private deviceFirstSeen = new Map<string, number>()

    private constructor() {}

    /**
     * Timestamp this device was first observed, recording it on first sight.
     * Devices without an id share a single bucket — they cannot be told
     * apart, so the best available behaviour is to grant the grace window
     * once.
     */
    private firstSeenAt(deviceId: string | undefined, timestamp: number): number {
        const key = deviceId || ''
        const existing = this.deviceFirstSeen.get(key)
        if (existing !== undefined) {
            return existing
        }
        this.deviceFirstSeen.set(key, timestamp)
        return timestamp
    }

    /**
     * A recording bot is never a speaker, and that has to be decided here:
     * a bot whose row escapes the isCurrentUser filter (Teams can list the
     * bot under a second endpoint id) would otherwise be attributed real
     * speech. A bot that streams audio in does speak, and keeps its turns.
     */
    private isBotName(name: string): boolean {
        const botName = (GLOBAL.get().bot_name || '').trim().toLowerCase()
        if (!botName) return false
        return name.trim().toLowerCase() === botName
    }

    /**
     * Best available name for a network participant, never downgrading.
     *
     * Teams already repairs this inside its own interceptor (it upgrades an
     * "Unknown" record once a displayName shows up), but a roster delta can
     * still omit a previously-known name — remember the best one per device.
     */
    private resolveNetworkName(user: NetworkUser): string {
        const deviceId = user.deviceId
        const incoming = (
            user.fullName ||
            user.displayName ||
            user.name ||
            ''
        ).trim()

        if (incoming && incoming !== UNKNOWN_SPEAKER) {
            if (deviceId) {
                this.deviceNames.set(deviceId, incoming)
            }
            return incoming
        }

        const remembered = deviceId
            ? this.deviceNames.get(deviceId)
            : undefined
        return remembered ?? UNKNOWN_SPEAKER
    }

    /**
     * Get the last time we received a speaker callback (regardless of speaking state)
     * Used to verify the page is still responsive before declaring bot removal
     */
    public getLastCallbackTime(): number | null {
        return this.lastCallbackTime
    }

    public static getInstance(): SpeakerManager {
        if (!SpeakerManager.instance) {
            SpeakerManager.instance = new SpeakerManager()
        }
        return SpeakerManager.instance
    }

    public static start(): void {
        SpeakerManager.getInstance()
    }

    public getCurrentSpeaker(): SpeakerData | null {
        return this.currentSpeaker
    }

    public async handleSpeakerUpdate(speakers: SpeakerData[]): Promise<void> {
        try {
            // Track when we received this callback (for bot removal detection)
            this.lastCallbackTime = Date.now()

            // Track cumulative participant names for alone-in-meeting detection.
            // v1 filters the bot from the speaker list, so every name here is
            // a real human participant.
            for (const speaker of speakers) {
                GLOBAL.addParticipantIfNotExists(speaker.name)
            }

            // Send the speaker state to the streaming service only if RECORDING is enabled
            if (Streaming.instance) {
                Streaming.instance.send_speaker_state(speakers)
            }

            await this.logSpeakers(speakers)

            // Count the active speakers
            const speakersCount = this.countActiveSpeakers(speakers)

            // Update the meeting state
            this.updateMeetingState(speakers, speakersCount)

            // Handle the speaker transcription
            await this.handleSpeakersTranscription(speakers, speakersCount)
        } catch (error) {
            console.error(
                '[SpeakerManager] ❌ Error handling speaker update:',
                error,
            )
            throw error
        }
    }

    public async handleNetworkSpeakerUpdate(
        networkUsers: NetworkUser[],
        timestamp: number,
    ): Promise<void> {
        const botCanSpeak = Boolean(GLOBAL.get().streaming_input)

        const speakers: SpeakerData[] = networkUsers
            .filter((user) => !user.isCurrentUser)
            .map((user, index) => {
                const stableName = this.resolveNetworkName(user)
                // Audio can beat the roster: the first audio event may resolve
                // to a device whose name has not been decoded yet, and
                // attributing that speech to the literal "Unknown" burns it
                // into the artifact permanently. Withhold the speaking flag
                // while the name is unresolved and the device is newly seen —
                // the roster lands within a second or two, and the segment
                // then opens under the correct name. After the grace window
                // an unresolved name is real (not a race), so stop
                // suppressing.
                const nameResolved = stableName !== UNKNOWN_SPEAKER
                const withinRosterGrace =
                    timestamp - this.firstSeenAt(user.deviceId, timestamp) <
                    ROSTER_GRACE_MS
                return {
                    name: stableName,
                    id: index + 1,
                    timestamp,
                    isSpeaking:
                        user.isSpeaking === true &&
                        (nameResolved || !withinRosterGrace) &&
                        (botCanSpeak || !this.isBotName(stableName)),
                }
            })

        await this.handleSpeakerUpdate(speakers)
    }

    private async logSpeakers(speakers: SpeakerData[]): Promise<void> {
        const input = JSON.stringify(speakers)
        const maskedSpeakers = speakers.map((speaker, index) => {
            return {
                ...speaker,
                name: `Speaker ${index + 1}`,
            }
        })
        console.table(maskedSpeakers)
        await fs.promises
            .appendFile(
                PathManager.getInstance().getSpeakerLogPath(),
                `${input}\n`,
            )
            .catch((e) => {
                console.error('Cannot append speaker log file:', e)
            })
    }

    private countActiveSpeakers(speakers: SpeakerData[]): number {
        return speakers.reduce(
            (acc, s) => acc + (s.isSpeaking === true ? 1 : 0),
            0,
        )
    }

    private updateMeetingState(
        speakers: SpeakerData[],
        speakersCount: number,
    ): void {
        if (!MeetingStateMachine.instance) {
            return
        }

        if (speakersCount > 0) {
            this.lastSpeakerTime = Date.now()
        } else if (speakers.length === 0) {
            // Only enable page logs when NO participants are found (SpeakerObserver failure)
            enablePrintPageLogs()
        }

        // Track no active speakers time - only set once when silence starts
        let noSpeakerDetectedTime =
            MeetingStateMachine.instance.getContext().noSpeakerDetectedTime
        if (speakersCount === 0) {
            // Only set the timer if it's not already set (first time silence detected)
            if (!noSpeakerDetectedTime) {
                noSpeakerDetectedTime = Date.now()
            }
            // Otherwise keep the existing value (don't reset the timer)
        } else if (speakersCount > 0) {
            noSpeakerDetectedTime = null
        }
        // If speakersCount is neither 0 nor > 0 (impossible), keep existing value

        const participantState: ParticipantState = {
            attendeesCount: speakers.length,
            firstUserJoined: speakers.length > 0,
            lastSpeakerTime: this.lastSpeakerTime,
            noSpeakerDetectedTime,
        }

        MeetingStateMachine.instance.updateParticipantState(participantState)
    }

    private async handleSpeakersTranscription(
        speakers: SpeakerData[],
        speakersCount: number,
    ): Promise<void> {
        switch (speakersCount) {
            case 0:
                await this.handleNoSpeakers(speakers)
                break
            case 1:
                await this.handleSingleSpeaker(speakers)
                break
            default:
                await this.handleMultipleSpeakers(speakers)
                break
        }
    }

    private async handleNoSpeakers(speakers: SpeakerData[]): Promise<void> {
        if (this.currentSpeaker) {
            this.currentSpeaker.isSpeaking = false
            if (speakers.length > 0) {
                this.currentSpeaker.timestamp = speakers[0].timestamp
            }
        }
    }

    private async handleSingleSpeaker(speakers: SpeakerData[]): Promise<void> {
        const activeSpeaker = speakers.find((v) => v.isSpeaking === true)
        if (!activeSpeaker) return

        if (activeSpeaker.name !== this.currentSpeaker?.name) {
            // Changement de speaker
            await uploadTranscriptTask(activeSpeaker, false)
        } else if (this.currentSpeaker.isSpeaking === false) {
            // The speaker has started speaking again after a pause
            if (
                activeSpeaker.timestamp >=
                this.currentSpeaker.timestamp + this.PAUSE_BETWEEN_SENTENCES
            ) {
                await uploadTranscriptTask(activeSpeaker, false)
            }
        }
        this.currentSpeaker = activeSpeaker
    }

    private async handleMultipleSpeakers(
        speakers: SpeakerData[],
    ): Promise<void> {
        const hasSpeakingCurrentSpeaker = speakers.some(
            (speaker) =>
                speaker.name === this.currentSpeaker?.name &&
                speaker.isSpeaking === true,
        )

        if (hasSpeakingCurrentSpeaker) {
            const activeSpeaker = speakers.find(
                (speaker) => speaker.name === this.currentSpeaker!.name,
            )
            if (this.currentSpeaker!.isSpeaking === false) {
                if (
                    activeSpeaker.timestamp >=
                    this.currentSpeaker!.timestamp +
                        this.PAUSE_BETWEEN_SENTENCES
                ) {
                    await uploadTranscriptTask(activeSpeaker, false)
                }
            }
            this.currentSpeaker = activeSpeaker
        } else {
            const activeSpeaker = speakers.find((v) => v.isSpeaking === true)
            await uploadTranscriptTask(activeSpeaker, false)
            this.currentSpeaker = activeSpeaker
        }
    }
}
