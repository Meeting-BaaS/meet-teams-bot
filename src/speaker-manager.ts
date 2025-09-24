import * as fs from 'fs'

import { ScreenRecorderManager } from './recording/ScreenRecorder'
import { MeetingStateMachine } from './state-machine/machine'

import { ApiTypes } from './api/types'
import { enablePrintPageLogs } from './browser/page-logger'
import { ParticipantState } from './state-machine/types'
import { SpeakerData } from './types'
import { uploadTranscriptTask } from './uploadTranscripts'
import { PathManager } from './utils/PathManager'

export class SpeakerManager {
    private static instance: SpeakerManager | null = null
    private lastSpeakerTime: number | null = null
    private speakerStartTimes: Map<string, number> = new Map()

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


    private createCompleteTranscript(
        speakerName: string,
        startTime: number,
        endTime: number,
    ): ApiTypes.PostableTranscript {
        const recordingStartTime =
            ScreenRecorderManager.getInstance().getRecordingStartTime()

        const relativeStartTime =
            recordingStartTime > 0
                ? (startTime - recordingStartTime) / 1000
                : 0
        const relativeEndTime =
            recordingStartTime > 0 ? (endTime - recordingStartTime) / 1000 : 0

        return {
            speaker: speakerName,
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
        // Check if any speakers stopped speaking and send their transcripts
        for (const [speakerName, startTime] of this.speakerStartTimes.entries()) {
            const endTime = speakers.length > 0 ? speakers[0].timestamp : Date.now()
            const transcript = this.createCompleteTranscript(speakerName, startTime, endTime)
            await uploadTranscriptTask(transcript)
        }
        
        // Clear all start times since no one is speaking
        this.speakerStartTimes.clear()
    }

    private async handleSingleSpeaker(speakers: SpeakerData[]): Promise<void> {
        const activeSpeaker = speakers.find((v) => v.isSpeaking === true)
        if (!activeSpeaker) return

        // Check if any other speakers stopped speaking
        for (const [speakerName, startTime] of this.speakerStartTimes.entries()) {
            if (speakerName !== activeSpeaker.name) {
                const transcript = this.createCompleteTranscript(speakerName, startTime, activeSpeaker.timestamp)
                await uploadTranscriptTask(transcript)
                this.speakerStartTimes.delete(speakerName)
            }
        }

        // Track when this speaker started speaking
        if (!this.speakerStartTimes.has(activeSpeaker.name)) {
            this.speakerStartTimes.set(activeSpeaker.name, activeSpeaker.timestamp)
        }
    }

    private async handleMultipleSpeakers(
        speakers: SpeakerData[],
    ): Promise<void> {
        const currentlySpeaking = speakers.filter(s => s.isSpeaking)
        const currentlySpeakingNames = new Set(currentlySpeaking.map(s => s.name))
        
        // Find speakers who stopped speaking
        for (const [speakerName, startTime] of this.speakerStartTimes.entries()) {
            if (!currentlySpeakingNames.has(speakerName)) {
                // This speaker stopped speaking, send their transcript
                const endTime = currentlySpeaking.length > 0 ? currentlySpeaking[0].timestamp : Date.now()
                const transcript = this.createCompleteTranscript(speakerName, startTime, endTime)
                await uploadTranscriptTask(transcript)
                this.speakerStartTimes.delete(speakerName)
            }
        }
        
        // Track new speakers who started speaking
        for (const speaker of currentlySpeaking) {
            if (!this.speakerStartTimes.has(speaker.name)) {
                this.speakerStartTimes.set(speaker.name, speaker.timestamp)
            }
        }
    }
}
