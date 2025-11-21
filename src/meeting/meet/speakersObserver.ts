import { Page } from '@playwright/test'
import { HtmlSnapshotService } from '../../services/html-snapshot-service'
import { RecordingMode, SpeakerData } from '../../types'

export class MeetSpeakersObserver {
    private page: Page
    private recordingMode: RecordingMode
    private botName: string
    private onSpeakersChange: (speakers: SpeakerData[]) => void
    private isObserving: boolean = false

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

                        console.log(
                            `[Meet] 🗣️ Network callback: ${speakers.length} speakers (${speakers.filter((s) => s.isSpeaking).length} speaking)`,
                        )
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

        // Ensure People panel is open (useful for visual confirmation)
        await this.ensurePeoplePanelOpen()

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
        console.log('[Meet] ✅ Observer stopped')
    }

    private async ensurePeoplePanelOpen(): Promise<void> {
        try {
            await this.page.evaluate(() => {
                // Check if People panel is already open
                const participantsList = document.querySelector(
                    "[aria-label='Participants']",
                )
                if (participantsList) {
                    console.log('[Meet-Browser] People panel already open')
                    return
                }

                console.log(
                    '[Meet-Browser] People panel not open, trying to open it...',
                )

                // Try multiple selectors for the people button
                const possibleSelectors = [
                    "[aria-label='Show everyone']",
                    "[aria-label='People']",
                    "[data-tooltip='Show everyone']",
                    "[data-tooltip='People']",
                    "button[aria-label*='people' i]",
                    "button[aria-label*='participants' i]",
                    "button[title*='people' i]",
                    "button[title*='participants' i]",
                ]

                for (const selector of possibleSelectors) {
                    const button = document.querySelector(
                        selector,
                    ) as HTMLElement
                    if (button && button.offsetParent !== null) {
                        // Check if visible
                        console.log(
                            `[Meet-Browser] Found people button with selector: ${selector}`,
                        )
                        button.click()
                        return
                    }
                }

                console.warn(
                    '[Meet-Browser] Could not find people button to open panel',
                )
            })
        } catch (error) {
            console.warn('[Meet] Failed to ensure people panel is open:', error)
        }
    }
}
