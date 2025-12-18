import { Page } from '@playwright/test'
import * as fs from 'fs/promises'
import { EnhancedSpeakerData } from '../../types'
import { PathManager } from '../../utils/PathManager'
import { generateStableUserId, createSequentialIdManager } from '../../utils/speaker-id'

/**
 * NetworkSpeakerLogger
 *
 * Logs speaker information detected via network interception with PII.
 * Captures full name, display name, profile picture, and device ID.
 * This is separate from UI-based speaker detection and is used for debugging/comparison.
 */
export class NetworkSpeakerLogger {
    private page: Page
    private botName: string
    private isActive: boolean = false
    private previousSpeakerState: Map<string, boolean> = new Map()
    private logFilePath: string
    private metadataFilePath: string
    // Sequential ID manager (reuses shared implementation from speaker-id.ts)
    private sequentialIdManager = createSequentialIdManager()
    // Track which participant IDs have had metadata written
    private writtenMetadata: Set<number> = new Set()
    private onSpeakersChange?: (speakers: EnhancedSpeakerData[]) => void
    // Throttle console logging (file writes still happen on every change)
    private lastConsoleLogTime: number = 0
    private static readonly CONSOLE_LOG_INTERVAL_MS = 1000

    constructor(
        page: Page,
        botName: string,
        onSpeakersChange?: (speakers: EnhancedSpeakerData[]) => void
    ) {
        this.page = page
        this.botName = botName
        this.logFilePath = PathManager.getInstance().getNetworkSpeakerLogPath()
        this.metadataFilePath = PathManager.getInstance().getNetworkSpeakerMetadataPath()
        this.onSpeakersChange = onSpeakersChange
    }

    /**
     * Get or assign a sequential ID for a speaker based on their stable hash ID.
     * This ensures speakers keep the same numeric ID across rejoins.
     */
    private getSequentialId(stableId: string): number {
        return this.sequentialIdManager.getSequentialId(stableId)
    }

    async start(): Promise<void> {
        if (this.isActive) {
            console.log('[NetworkSpeakerLogger] Already active')
            return
        }

        console.log('[NetworkSpeakerLogger] Starting network speaker logging...')

        // Register our callback to receive speaker updates from browser-bundle.ts
        // Flow: browser-bundle.ts → window.onNetworkSpeakerUpdate → meet.ts callback → here
        if ((this.page as any)._setNodeNetworkCallback) {
            console.log(
                '[NetworkSpeakerLogger] Registering callback with network interceptor',
            );
            (this.page as any)._setNodeNetworkCallback((payload: any) => {
                this.handleNetworkPayload(payload)
            })
            console.log('[NetworkSpeakerLogger] ✅ Callback registered')
        } else {
            console.warn(
                '[NetworkSpeakerLogger] Network callback setter not found - network interception may not be set up',
            )
        }

        this.isActive = true
        console.log('[NetworkSpeakerLogger] ✅ Logger started successfully')
    }

    private handleNetworkPayload(payload: any): void {
        // Early exit if logging has been stopped
        if (!this.isActive) {
            return
        }

        try {
            if (payload && payload.users) {
                // Filter out the bot itself (exclude if current user OR name matches bot name)
                const filteredUsers = payload.users.filter(
                    (s: any) => !s.isCurrentUser && s.name !== this.botName,
                )

                // Debug: Log the raw isSpeaking values to find the bug
                //console.log('[NetworkSpeakerLogger] DEBUG raw isSpeaking values:', filteredUsers.map((s: any) => ({ name: s.name, isSpeaking: s.isSpeaking, type: typeof s.isSpeaking })))

                // Convert network speakers to EnhancedSpeakerData format with PII
                const speakers: EnhancedSpeakerData[] = filteredUsers.map((s: any) => {
                    const stableId = generateStableUserId(s.fullName || s.name || 'Unknown', s.profilePicture)
                    const sequentialId = this.getSequentialId(stableId)
                    return {
                        name: s.name || 'Unknown',
                        id: sequentialId,
                        timestamp: payload.timestamp || Date.now(),
                        isSpeaking: s.isSpeaking === true,
                        // PII fields
                        fullName: s.fullName,
                        displayName: s.displayName,
                        profilePicture: s.profilePicture,
                        // deviceId: s.deviceId,  // Could be useful for detecting merged speakers
                    }
                })

                // Notify listeners (SpeakerManager)
                if (this.onSpeakersChange) {
                    this.onSpeakersChange(speakers)
                }

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
                    // Throttle console logging to reduce noise
                    const now = Date.now()
                    if (now - this.lastConsoleLogTime >= NetworkSpeakerLogger.CONSOLE_LOG_INTERVAL_MS) {
                        this.logSpeakersTable(speakers)
                        this.lastConsoleLogTime = now
                    }
                    // File writes still happen on every change
                    this.writeLogToFile(speakers).catch((err) => {
                        console.error(
                            '[NetworkSpeakerLogger] Failed to write log to file:',
                            err,
                        )
                    })
                }

                // Update state for all speakers
                speakers.forEach((speaker) => {
                    this.previousSpeakerState.set(speaker.name, speaker.isSpeaking)
                })
            }
        } catch (error) {
            console.error('[NetworkSpeakerLogger] Error in network callback:', error)
        }
    }

    private logSpeakersTable(speakers: EnhancedSpeakerData[]): void {
        if (speakers.length === 0) {
            console.log('[NetworkSpeakerLogger] No speakers detected')
            return
        }

        // Create anonymized version for console (same pattern as speaker-manager.ts)
        const anonymizedSpeakers = speakers.map((speaker, index) => ({
            ...speaker,
            name: `Speaker ${index + 1}`,
            fullName: undefined, // Anonymize PII
            displayName: undefined,
            profilePicture: undefined,
        }))

        // Build table header
        const lines = [
            '│ name            │ id              │ timestamp       │ isSpeaking      │',
            '│ --------------- │ --------------- │ --------------- │ --------------- │',
        ]

        // Add each speaker as a row (using anonymized names)
        anonymizedSpeakers.forEach((speaker) => {
            const name = speaker.name.padEnd(15).substring(0, 15)
            const id = String(speaker.id).padEnd(15).substring(0, 15)
            const timestamp = String(speaker.timestamp).padEnd(15).substring(0, 15)
            const isSpeaking = String(speaker.isSpeaking).padEnd(15).substring(0, 15)
            lines.push(`│ ${name} │ ${id} │ ${timestamp} │ ${isSpeaking} │`)
        })

        console.log('[NetworkSpeakerLogger] Network speakers:')
        lines.forEach((line) => console.log(line))
    }

    private async writeLogToFile(speakers: EnhancedSpeakerData[]): Promise<void> {
        try {
            const writePromises: Promise<void>[] = []

            // Collect metadata for new participants (with PII)
            const metadataLines: string[] = []
            for (const speaker of speakers) {
                if (!this.writtenMetadata.has(speaker.id)) {
                    const metadata = {
                        type: 'metadata',
                        id: speaker.id,
                        name: speaker.name,
                        fullName: speaker.fullName,
                        displayName: speaker.displayName,
                        profilePicture: speaker.profilePicture
                    }
                    metadataLines.push(JSON.stringify(metadata))
                    this.writtenMetadata.add(speaker.id)
                }
            }
            if (metadataLines.length > 0) {
                writePromises.push(fs.appendFile(this.metadataFilePath, metadataLines.join('\n') + '\n'))
            }

            // Prepare activity log (same format as speaker_separation.log)
            const activityLog = speakers.map(s => ({
                name: s.name,
                id: s.id,
                timestamp: s.timestamp,
                isSpeaking: s.isSpeaking
            }))
            writePromises.push(fs.appendFile(this.logFilePath, JSON.stringify(activityLog) + '\n'))

            // Write both files in parallel
            await Promise.all(writePromises)
        } catch (error) {
            console.error(
                '[NetworkSpeakerLogger] Cannot append network speaker log file:',
                error,
            )
        }
    }

    stop(): void {
        if (!this.isActive) {
            return
        }

        console.log('[NetworkSpeakerLogger] Stopping logger...')
        this.isActive = false
        this.previousSpeakerState.clear()
        console.log('[NetworkSpeakerLogger] ✅ Logger stopped')
    }
}
