import { Page } from '@playwright/test'
import * as fs from 'fs/promises'
import * as crypto from 'crypto'
import { EnhancedSpeakerData } from '../../types'
import { PathManager } from '../../utils/PathManager'

/**
 * Generate a stable user ID from profile picture URL or full name.
 * This ID persists across rejoin events since it's based on account-level data.
 */
function generateStableUserId(fullName: string, profilePicture?: string): string {
    // Prefer profile picture URL (tied to Google account) over name for stability
    const input = profilePicture || fullName
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16)
}

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
    private isLogging: boolean = false
    private previousSpeakerState: Map<string, boolean> = new Map()
    private logFilePath: string
    private participantsMetadataPath: string
    // Persistent mapping from hash-based stable ID to sequential numeric ID
    private stableIdToSequentialId: Map<string, number> = new Map()
    private nextSequentialId: number = 1
    // Track which participant IDs have been written to metadata file
    private writtenParticipantIds: Set<number> = new Set()

    constructor(page: Page, botName: string) {
        this.page = page
        this.botName = botName
        this.logFilePath = PathManager.getInstance().getNetworkSpeakerLogPath()
        this.participantsMetadataPath = PathManager.getInstance().getParticipantsMetadataPath()
    }

    /**
     * Get or assign a sequential ID for a speaker based on their stable hash ID.
     * This ensures speakers keep the same numeric ID across rejoins.
     */
    private getSequentialId(stableId: string): number {
        if (!this.stableIdToSequentialId.has(stableId)) {
            this.stableIdToSequentialId.set(stableId, this.nextSequentialId)
            this.nextSequentialId++
        }
        return this.stableIdToSequentialId.get(stableId)!
    }

    async start(): Promise<void> {
        if (this.isLogging) {
            console.log('[NetworkSpeakerLogger] Already logging')
            return
        }

        console.log('[NetworkSpeakerLogger] Starting network speaker logging...')

        // Register our callback with the existing network interceptor
        if ((this.page as any)._updateNetworkCallback) {
            console.log(
                '[NetworkSpeakerLogger] Registering callback with network interceptor',
            )
            ;(this.page as any)._updateNetworkCallback((payload: any) => {
                this.handleNetworkPayload(payload)
            })
            console.log('[NetworkSpeakerLogger] ✅ Callback registered')
        } else {
            console.warn(
                '[NetworkSpeakerLogger] Network callback updater not found - network interception may not be set up',
            )
        }

        this.isLogging = true
        console.log('[NetworkSpeakerLogger] ✅ Logger started successfully')
    }

    private handleNetworkPayload(payload: any): void {
        try {
            if (payload && payload.users) {
                // Filter out the bot itself (exclude if current user OR name matches bot name)
                const filteredUsers = payload.users.filter(
                    (s: any) => !s.isCurrentUser && s.name !== this.botName,
                )

                // Convert network speakers to EnhancedSpeakerData format with PII
                const speakers: EnhancedSpeakerData[] = filteredUsers.map((s: any) => {
                    const stableId = generateStableUserId(s.fullName || s.name || 'Unknown', s.profilePicture)
                    const sequentialId = this.getSequentialId(stableId)
                    return {
                        name: s.name || 'Unknown',
                        id: sequentialId,
                        timestamp: payload.timestamp || Date.now(),
                        isSpeaking: s.isSpeaking || false,
                        // PII fields
                        fullName: s.fullName,
                        displayName: s.displayName,
                        profilePicture: s.profilePicture,
                        // deviceId: s.deviceId,  // Could be useful for detecting merged speakers
                    }
                })

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

                // Write participant metadata for new participants
                for (const speaker of speakers) {
                    this.writeParticipantMetadata(speaker).catch((err) => {
                        console.error(
                            '[NetworkSpeakerLogger] Failed to write participant metadata:',
                            err,
                        )
                    })
                }

                // Log only on changes (including initial state)
                if (hasChange) {
                    this.logSpeakersTable(speakers)
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
            // Write activity log without PII (just name, id, timestamp, isSpeaking)
            const activityLog = speakers.map(s => ({
                name: s.name,
                id: s.id,
                timestamp: s.timestamp,
                isSpeaking: s.isSpeaking
            }))
            const logEntry = JSON.stringify(activityLog)
            await fs.appendFile(this.logFilePath, `${logEntry}\n`)
        } catch (error) {
            console.error(
                '[NetworkSpeakerLogger] Cannot append network speaker log file:',
                error,
            )
        }
    }

    private async writeParticipantMetadata(speaker: EnhancedSpeakerData): Promise<void> {
        try {
            // Only write if we haven't written this participant ID yet
            if (this.writtenParticipantIds.has(speaker.id)) {
                return
            }

            // Write participant metadata (id, name, fullName, displayName, profilePicture)
            const metadata = {
                id: speaker.id,
                name: speaker.name,
                fullName: speaker.fullName,
                displayName: speaker.displayName,
                profilePicture: speaker.profilePicture
            }
            const logEntry = JSON.stringify(metadata)
            await fs.appendFile(this.participantsMetadataPath, `${logEntry}\n`)

            // Mark this ID as written
            this.writtenParticipantIds.add(speaker.id)
        } catch (error) {
            console.error(
                '[NetworkSpeakerLogger] Cannot append participants metadata file:',
                error,
            )
        }
    }

    stop(): void {
        if (!this.isLogging) {
            return
        }

        console.log('[NetworkSpeakerLogger] Stopping logger...')
        this.isLogging = false
        this.previousSpeakerState.clear()
        console.log('[NetworkSpeakerLogger] ✅ Logger stopped')
    }
}
