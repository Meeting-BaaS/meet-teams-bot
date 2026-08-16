import * as fs from 'fs'

import { DiarizationTracker } from './diarization-tracker'
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
    // Best-effort sequential id last seen per network device. v1 assigns ids by
    // roster index (not a stable per-participant key), so this is only used to
    // stamp a user_id onto a segment during Unknown-backfill; the name is the
    // load-bearing repair. Keyed by deviceId to stay per-participant.
    private deviceUserIds = new Map<string, number>()
    // File-based diarization tracker. Fed the active speaker from the single
    // sink below (network AND ui-observer flow through handleSpeakerUpdate), so
    // the health monitor arbitrates on ACTUAL segment production.
    private diarizationTracker: DiarizationTracker | null = null
    // When each device was first seen, so the roster-race grace window is
    // scoped to that participant rather than to the start of the meeting: a
    // participant joining at minute 20 races their own roster entry exactly
    // like the ones present at the start, and a meeting-wide anchor would
    // have expired long ago.
    private deviceFirstSeen = new Map<string, number>()

    // True once the network path has reported an actual SPEAKING participant.
    // Until then the Meet UI bridge (handleUiBridgeUpdate) is allowed to feed
    // diarization, because a participant's audio track only starts flowing a
    // few seconds after they first speak — Meet's UI indicator fires earlier.
    private networkSpeakerActive = false
    private uiBridgeMuteLogged = false

    private constructor() {}

    /**
     * Entry point for the Meet UI speaker bridge: the DOM speaking indicator
     * observed in parallel with the (primary) network path.
     *
     * Why it exists: at first speech after silence, a participant's WebRTC
     * audio track takes 3-5s to spin up before the network path can see them —
     * Meet's own UI indicator lights up almost immediately. That gap produced
     * leading-"Unknown" runs at the start of transcripts.
     *
     * Arbitration: UI events flow only while the network path has never
     * reported a speaking participant, OR the network path has been retired
     * (watchdog fallback — networkRetired=true, this observer is now primary).
     * From the first network speaker on, with the network path still live, the
     * bridge is muted: the network path carries deviceIds and survives DOM
     * changes, so it stays authoritative.
     */
    public async handleUiBridgeUpdate(
        observed: SpeakerData[],
        networkRetired: boolean,
    ): Promise<void> {
        if (this.networkSpeakerActive && !networkRetired) {
            if (!this.uiBridgeMuteLogged) {
                this.uiBridgeMuteLogged = true
                console.log(
                    '[SpeakerBridge] Network path delivered its first speaker — UI bridge muted',
                )
            }
            return
        }
        await this.handleSpeakerUpdate(observed, 'ui-observer')
    }

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
        const instance = SpeakerManager.getInstance()
        // Initialize the file-based diarization tracker (no API calls). Safe to
        // call more than once — getInstance() is a singleton.
        instance.diarizationTracker = DiarizationTracker.getInstance()
    }

    /**
     * Finalize diarization tracking when the meeting ends. Hands the FINAL
     * roster to the tracker so any segment written while a participant was
     * still unnamed ("Unknown") gets repaired before the artifact is closed:
     * the live path can only ever fix the segment that is still open; by the
     * end of the meeting we know every name we are ever going to know.
     */
    public static async finalize(): Promise<void> {
        const instance = SpeakerManager.getInstance()
        if (!instance.diarizationTracker) {
            return
        }
        const lastTimestamp = Date.now()
        const meetingStartTime = MeetingStateMachine.instance?.getStartTime()
        if (!meetingStartTime) {
            return
        }
        await instance.diarizationTracker.end(
            lastTimestamp,
            meetingStartTime,
            (deviceId) => instance.resolveDeviceForBackfill(deviceId),
        )
    }

    /**
     * Final name + best-effort id for a device, or undefined if the roster
     * never named it. Keyed by device (never by name) so two participants both
     * sitting under "Unknown" can't have one's speech handed to the other.
     */
    private resolveDeviceForBackfill(
        deviceId: string,
    ): { name: string; userId: number } | undefined {
        const name = this.deviceNames.get(deviceId)
        if (!name || name === UNKNOWN_SPEAKER) {
            return undefined
        }
        return { name, userId: this.deviceUserIds.get(deviceId) ?? 0 }
    }

    public getCurrentSpeaker(): SpeakerData | null {
        return this.currentSpeaker
    }

    public async handleSpeakerUpdate(
        speakers: SpeakerData[],
        source: string,
    ): Promise<void> {
        try {
            // Which source drives every committed speaker update: network CSRC,
            // network dcrpc (NetEq), roster, or the UI-observer bridge. This is the
            // only node-side signal of source — the browser-side interceptor logs do
            // not reach the bot log. Count only; names/ids are PII and this ships to S3.
            const speakingNow = speakers.filter((s) => s.isSpeaking).length
            console.log(
                `[SPEAKER-SRC] source=${source} speaking=${speakingNow}/${speakers.length}`,
            )
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
        source: string = 'network',
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
                // Remember the id for this device so Unknown-backfill can stamp
                // a user_id onto segments repaired at finalize.
                if (user.deviceId) {
                    this.deviceUserIds.set(user.deviceId, index + 1)
                }
                return {
                    name: stableName,
                    id: index + 1,
                    timestamp,
                    // Carried so the diarization tracker can repair a segment
                    // opened before this device's name resolved.
                    deviceId: user.deviceId,
                    isSpeaking:
                        user.isSpeaking === true &&
                        (nameResolved || !withinRosterGrace) &&
                        (botCanSpeak || !this.isBotName(stableName)),
                }
            })

        // First actual speaker from the network path mutes the Meet UI bridge —
        // from here the track-based signal is live and authoritative.
        if (!this.networkSpeakerActive && speakers.some((s) => s.isSpeaking)) {
            this.networkSpeakerActive = true
            console.log(
                '[SpeakerBridge] First speaking participant on the network path',
            )
        }

        await this.handleSpeakerUpdate(speakers, source)
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

        // Meeting clock for the diarization tracker. Guarded (not early-return)
        // so the existing transcript path is never skipped when it is 0/unset.
        const meetingStartTime = MeetingStateMachine.instance?.getStartTime()

        if (activeSpeaker.name !== this.currentSpeaker?.name) {
            // Changement de speaker
            if (meetingStartTime) {
                this.diarizationTracker?.updateSpeaker(
                    activeSpeaker,
                    meetingStartTime,
                )
            }
            await uploadTranscriptTask(activeSpeaker, false)
        } else if (this.currentSpeaker.isSpeaking === false) {
            // The speaker has started speaking again after a pause
            if (
                activeSpeaker.timestamp >=
                this.currentSpeaker.timestamp + this.PAUSE_BETWEEN_SENTENCES
            ) {
                if (meetingStartTime) {
                    this.diarizationTracker?.updateSpeaker(
                        activeSpeaker,
                        meetingStartTime,
                    )
                }
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

        // Meeting clock for the diarization tracker. Guarded (not early-return)
        // so the existing transcript path is never skipped when it is 0/unset.
        const meetingStartTime = MeetingStateMachine.instance?.getStartTime()

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
                    if (meetingStartTime) {
                        this.diarizationTracker?.updateSpeaker(
                            activeSpeaker,
                            meetingStartTime,
                        )
                    }
                    await uploadTranscriptTask(activeSpeaker, false)
                }
            }
            this.currentSpeaker = activeSpeaker
        } else {
            const activeSpeaker = speakers.find((v) => v.isSpeaking === true)
            if (meetingStartTime) {
                this.diarizationTracker?.updateSpeaker(
                    activeSpeaker,
                    meetingStartTime,
                )
            }
            await uploadTranscriptTask(activeSpeaker, false)
            this.currentSpeaker = activeSpeaker
        }
    }
}
