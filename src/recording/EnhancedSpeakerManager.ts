// Example integration with existing SpeakerManager
// This shows how to connect participant stream capture with your current speaker detection

import { SpeakerManager } from '../speaker-manager'
import { SpeakerData } from '../types'
import { ParticipantStreamCapture } from './ParticipantStreamCapture'

class EnhancedSpeakerManager {
    private speakerManager: SpeakerManager
    private participantStreamCapture: ParticipantStreamCapture | null = null

    constructor() {
        this.speakerManager = SpeakerManager.getInstance()
        this.initializeParticipantStreamCapture()
    }

    private initializeParticipantStreamCapture(): void {
        this.participantStreamCapture = ParticipantStreamCapture.getInstance({
            enabled: true,
            websocketPort: 8080,
            captureAudio: true,
            captureVideo: true,
            chunkSizeMs: 1000,
        })

        // Listen for participant events
        this.participantStreamCapture.on('participantJoined', (stream) => {
            console.log(
                `🎯 New participant stream started: ${stream.participantName}`,
            )
        })

        this.participantStreamCapture.on('participantLeft', (stream) => {
            console.log(
                `👋 Participant stream ended: ${stream.participantName}`,
            )
        })

        this.participantStreamCapture.on('speakingStatusChanged', (data) => {
            const { stream, isSpeaking, timestamp } = data
            console.log(
                `🎤 ${stream.participantName} ${isSpeaking ? 'started' : 'stopped'} speaking`,
            )

            // You could correlate this with your existing speaker detection
            this.correlateWithSpeakerDetection(stream, isSpeaking, timestamp)
        })
    }

    private correlateWithSpeakerDetection(
        stream: any,
        isSpeaking: boolean,
        timestamp: number,
    ): void {
        // This method would correlate the WebRTC stream speaking status
        // with your existing DOM-based speaker detection

        // Example: Update your existing SpeakerData with WebRTC confirmation
        const currentSpeakers = this.getCurrentSpeakers() // You'd need to implement this

        const matchingSpeaker = currentSpeakers.find(
            (speaker) => speaker.name === stream.participantName,
        )

        if (matchingSpeaker) {
            // Correlate WebRTC detection with DOM detection
            const timeDiff = Math.abs(Date.now() - timestamp)
            if (timeDiff < 2000) {
                // Within 2 seconds
                console.log(
                    `✅ WebRTC and DOM speaker detection aligned for ${stream.participantName}`,
                )
            } else {
                console.log(
                    `⚠️ WebRTC and DOM speaker detection mismatch for ${stream.participantName}`,
                )
            }
        }
    }

    public async startParticipantStreamCapture(): Promise<void> {
        if (this.participantStreamCapture) {
            try {
                await this.participantStreamCapture.startCapture()
                console.log(
                    '✅ Enhanced speaker manager started participant stream capture',
                )
            } catch (error) {
                console.error(
                    '❌ Failed to start participant stream capture:',
                    error,
                )
            }
        }
    }

    public async stopParticipantStreamCapture(): Promise<void> {
        if (this.participantStreamCapture) {
            try {
                await this.participantStreamCapture.stopCapture()
                console.log(
                    '✅ Enhanced speaker manager stopped participant stream capture',
                )

                // Log detailed statistics
                this.participantStreamCapture.logParticipantStats()
            } catch (error) {
                console.error(
                    '❌ Failed to stop participant stream capture:',
                    error,
                )
            }
        }
    }

    public getParticipantStreamStats(): any[] {
        return this.participantStreamCapture?.getParticipantStats() || []
    }

    // Override the existing handleSpeakerUpdate method to include stream correlation
    public async handleSpeakerUpdate(speakers: SpeakerData[]): Promise<void> {
        // Call the speaker manager method first
        await this.speakerManager.handleSpeakerUpdate(speakers)

        // Add stream correlation logic
        if (this.participantStreamCapture) {
            const streamStats =
                this.participantStreamCapture.getParticipantStats()

            console.log(
                `📊 Speaker Update - DOM: ${speakers.length} speakers, Streams: ${streamStats.length} participants`,
            )

            // Log any mismatches between DOM detection and stream capture
            speakers.forEach((speaker) => {
                const streamParticipant = streamStats.find(
                    (stat) => stat.participantName === speaker.name,
                )

                if (!streamParticipant) {
                    console.log(
                        `⚠️ Speaker ${speaker.name} detected in DOM but no stream captured`,
                    )
                } else if (speaker.isSpeaking !== streamParticipant.isActive) {
                    console.log(
                        `⚠️ Speaking status mismatch for ${speaker.name}: DOM=${speaker.isSpeaking}, Stream=${streamParticipant.isActive}`,
                    )
                }
            })
        }
    }

    private getCurrentSpeakers(): SpeakerData[] {
        // This would return the current speakers from your existing system
        // Implementation depends on your current SpeakerManager structure
        return []
    }
}

export { EnhancedSpeakerManager }
