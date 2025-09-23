import * as fs from 'fs'

import { ScreenRecorderManager } from './recording/ScreenRecorder'
import { MeetingStateMachine } from './state-machine/machine'
import { Streaming } from './streaming'

import { ApiTypes } from './api/types'
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
        try {
            // Create simplified output format for streaming service
            const speakerOutputs = this.createSpeakerOutputs(speakers)

            // Send the speaker transcripts to the streaming service only if RECORDING is enabled
            if (Streaming.instance && speakerOutputs.length > 0) {
                Streaming.instance.send_speaker_state(speakerOutputs)
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

    private createSpeakerOutputs(
        speakers: SpeakerData[],
    ): ApiTypes.PostableTranscript[] {
        const recordingStartTime =
            ScreenRecorderManager.getInstance().getRecordingStartTime()
        const currentTime = Date.now()

        // Only include speakers who are currently speaking
        return speakers
            .filter((speaker) => speaker.isSpeaking)
            .map((speaker) => this.createSpeakerOutput(speaker, currentTime))
    }

    private createSpeakerOutput(
        speaker: SpeakerData,
        currentTime?: number,
    ): ApiTypes.PostableTranscript {
        const recordingStartTime =
            ScreenRecorderManager.getInstance().getRecordingStartTime()
        const time = currentTime || Date.now()

        const relativeStartTime =
            recordingStartTime > 0
                ? (speaker.timestamp - recordingStartTime) / 1000
                : 0
        const relativeEndTime =
            recordingStartTime > 0 ? (time - recordingStartTime) / 1000 : 0

        return {
            speaker: speaker.name,
            start_time: relativeStartTime,
            end_time: relativeEndTime,
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

        // Update last speaker time only when someone is actually speaking
        if (speakersCount > 0) {
            this.lastSpeakerTime = Date.now()
        } else if (speakers.length === 0) {
            // Only enable page logs when NO participants are found (SpeakerObserver failure)
            enablePrintPageLogs()
        }

        // Fix: noSpeakerDetectedTime should be set when there are participants but no one is speaking
        // It should only be reset to null when someone actually starts speaking
        const participantState: ParticipantState = {
            attendeesCount: speakers.length,
            firstUserJoined: speakers.length > 0,
            lastSpeakerTime: this.lastSpeakerTime,
            noSpeakerDetectedTime:
                speakers.length > 0 && speakersCount === 0
                    ? Date.now()
                    : speakersCount > 0
                      ? null
                      : undefined, // Let the state machine handle the existing value
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
            const speakerOutput = this.createSpeakerOutput(activeSpeaker)
            await uploadTranscriptTask(speakerOutput)
        } else if (this.currentSpeaker.isSpeaking === false) {
            // The speaker has started speaking again after a pause
            if (
                activeSpeaker.timestamp >=
                this.currentSpeaker.timestamp + this.PAUSE_BETWEEN_SENTENCES
            ) {
                const speakerOutput = this.createSpeakerOutput(activeSpeaker)
                await uploadTranscriptTask(speakerOutput)
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
                    const speakerOutput =
                        this.createSpeakerOutput(activeSpeaker)
                    await uploadTranscriptTask(speakerOutput)
                }
            }
            this.currentSpeaker = activeSpeaker
        } else {
            const activeSpeaker = speakers.find((v) => v.isSpeaking === true)
            if (activeSpeaker) {
                const speakerOutput = this.createSpeakerOutput(activeSpeaker)
                await uploadTranscriptTask(speakerOutput)
            }
            this.currentSpeaker = activeSpeaker
        }
    }
}
