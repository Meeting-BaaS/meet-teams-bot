import * as fs from 'fs'

import { MeetingStateMachine } from './state-machine/machine'
import { Streaming } from './streaming'

import { ParticipantState } from './state-machine/types'
import { SpeakerData } from './types'
import { uploadTranscriptTask } from './uploadTranscripts'
import { PathManager } from './utils/PathManager'

export class SpeakerManager {
    private static instance: SpeakerManager | null = null
    private currentSpeaker: SpeakerData | null = null
    private readonly PAUSE_BETWEEN_SENTENCES = 1000 // 1 second
    private lastSpeakerTime: number | null = null

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

    public async handleSpeakerUpdate(speakers: SpeakerData[]): Promise<void> {
        // TEMPORARILY DISABLED - Speaker observation is disabled
        return

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
        console.table(speakers)
        const input = JSON.stringify(speakers)
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
        }

        const participantState: ParticipantState = {
            attendeesCount: speakers.length,
            firstUserJoined: speakers.length > 0,
            lastSpeakerTime: this.lastSpeakerTime,
            noSpeakerDetectedTime: speakersCount === 0 ? Date.now() : null,
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
