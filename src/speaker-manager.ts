import * as fs from 'fs'

import { MeetingStateMachine } from './state-machine/machine'
import { Streaming } from './streaming'

import { enablePrintPageLogs } from './browser/page-logger'
import { ParticipantState } from './state-machine/types'
import { SpeakerData } from './types'
import { uploadTranscriptTask } from './uploadTranscripts'
import { PathManager } from './utils/PathManager'

export class SpeakerManager {
    private static instance: SpeakerManager | null = null
    private currentSpeaker: SpeakerData | null = null
    private readonly PAUSE_BETWEEN_SENTENCES = 1000 // 1 second
    private lastSpeakerTime: number | null = null
    private previousSpeakerState: Map<string, { isSpeaking: boolean }> =
        new Map()
    private lastSpeakingCount: number = 0

    private constructor() {}

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

    private async logSpeakers(speakers: SpeakerData[]): Promise<void> {
        const input = JSON.stringify(speakers)

        // Check if there's a change in speaker state
        const speakingCount = speakers.filter(
            (s) => s.isSpeaking === true,
        ).length
        let hasChange = false

        if (this.previousSpeakerState.size === 0) {
            hasChange = true // Always log initial state
        } else {
            // Check if any speaker's state changed
            hasChange = speakers.some((speaker) => {
                const previousState = this.previousSpeakerState.get(
                    speaker.name,
                )
                return (
                    previousState === undefined ||
                    previousState.isSpeaking !== speaker.isSpeaking
                )
            })
            // Also check if the number of speaking participants changed
            if (speakingCount !== this.lastSpeakingCount) {
                hasChange = true
            }
            // Also check if any speaker left
            if (!hasChange && this.previousSpeakerState.size !== speakers.length) {
                hasChange = true
            }
        }

        // Only log if there's a change
        if (hasChange) {
            // Create masked version for console (anonymized names)
            const maskedSpeakers = speakers.map((speaker, index) => {
                return {
                    ...speaker,
                    name: `Speaker ${index + 1}`,
                }
            })
            // Log anonymized speaker names to console
            console.table(maskedSpeakers)

            // Update previous state
            this.previousSpeakerState.clear()
            speakers.forEach((speaker) => {
                this.previousSpeakerState.set(speaker.name, {
                    isSpeaking: speaker.isSpeaking,
                })
            })
            this.lastSpeakingCount = speakingCount
        }

        // Always append to file (for historical record)
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
