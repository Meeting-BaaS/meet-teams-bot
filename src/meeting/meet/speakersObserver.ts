import { Page } from '@playwright/test'
import { HtmlSnapshotService } from '../../services/html-snapshot-service'
import { RecordingMode, SpeakerData } from '../../types'

export class MeetSpeakersObserver {
    private page: Page
    private recordingMode: RecordingMode
    private botName: string
    private onSpeakersChange: (speakers: SpeakerData[]) => void
    private isObserving: boolean = false
    private previousSpeakerState: Map<string, boolean> = new Map() // Track previous speaking state

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
        if (this.isObserving) {
            console.warn('[Meet] Already observing')
            return
        }

        console.log('[Meet] Starting speaker observation (Network Mode)...')

        // Network interception is already set up in meet.ts before page load
        // Register our callback with the existing network interceptor
        if ((this.page as any)._updateNetworkCallback) {
            console.log(
                '[Meet] Registering speaker callback with network interceptor',
            )
            ;(this.page as any)._updateNetworkCallback((payload: any) => {
                try {
                    if (payload && payload.users) {
                        // Filter out the bot itself (exclude if current user OR name matches bot name)
                        const filteredUsers = payload.users.filter(
                            (s: any) =>
                                !s.isCurrentUser && s.name !== this.botName,
                        )

                        // Convert network speakers to SpeakerData format
                        const speakers: SpeakerData[] = filteredUsers.map(
                            (s: any) => ({
                                name: s.name || 'Unknown',
                                id: 0, // TODO: Hash deviceId to number if needed
                                timestamp: payload.timestamp || Date.now(),
                                isSpeaking: s.isSpeaking || false,
                            }),
                        )

                        // Check for changes in speaking status
                        const hasChange = speakers.some((speaker) => {
                            const previousState = this.previousSpeakerState.get(
                                speaker.name,
                            )
                            return (
                                previousState === undefined ||
                                previousState !== speaker.isSpeaking
                            )
                        })

                        // Log only on changes (including initial state)
                        if (hasChange) {
                            const speakingCount = speakers.filter(
                                (s) => s.isSpeaking,
                            ).length
                            console.log(
                                `[Meet] 🗣️ Speaker update: ${speakers.length} speakers (${speakingCount} speaking)`,
                            )

                            // Log speaker map on change
                            speakers.forEach((speaker) => {
                                const previousState =
                                    this.previousSpeakerState.get(speaker.name)
                                if (
                                    previousState === undefined ||
                                    previousState !== speaker.isSpeaking
                                ) {
                                    if (previousState === undefined) {
                                        console.log(
                                            `[MEET-DEBUG-SPEAKER] ${speaker.name}: ${speaker.isSpeaking ? 'speaking' : 'muted'}`,
                                        )
                                    } else {
                                        console.log(
                                            `[MEET-DEBUG-SPEAKER] ${speaker.name}: ${previousState ? 'stopped' : 'started'} speaking`,
                                        )
                                    }
                                }
                            })
                        }

                        // Update state for all speakers
                        speakers.forEach((speaker) => {
                            this.previousSpeakerState.set(
                                speaker.name,
                                speaker.isSpeaking,
                            )
                        })

                        this.onSpeakersChange(speakers)
                    }
                } catch (error) {
                    console.error('[Meet] Error in network callback:', error)
                }
            })
            console.log('[Meet] ✅ Speaker callback registered')
        } else {
            console.warn(
                '[Meet] Network callback updater not found - network interception may not be set up',
            )
        }

        this.isObserving = true
        console.log('[Meet] ✅ Observer started successfully')

        // Capture DOM state after Speakers Observer is started
        const htmlSnapshot = HtmlSnapshotService.getInstance()
        await htmlSnapshot.captureSnapshot(
            this.page,
            'meet_speaker_observer_started',
        )
    }

    public stopObserving(): void {
        if (!this.isObserving) {
            return
        }

        console.log('[Meet] Stopping observation...')
        this.isObserving = false
        this.previousSpeakerState.clear()
        console.log('[Meet] ✅ Observer stopped')
    }
}
