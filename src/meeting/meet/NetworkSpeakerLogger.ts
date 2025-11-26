import { Page } from '@playwright/test'
import * as fs from 'fs/promises'
import { SpeakerData } from '../../types'
import { PathManager } from '../../utils/PathManager'

/**
 * NetworkSpeakerLogger
 *
 * Logs speaker information detected via network interception.
 * This is separate from UI-based speaker detection and is used for debugging/comparison.
 */
export class NetworkSpeakerLogger {
    private page: Page
    private botName: string
    private isLogging: boolean = false
    private previousSpeakerState: Map<string, boolean> = new Map()
    private logFilePath: string

    constructor(page: Page, botName: string) {
        this.page = page
        this.botName = botName
        this.logFilePath = PathManager.getInstance().getNetworkSpeakerLogPath()
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

                // Convert network speakers to SpeakerData format
                const speakers: SpeakerData[] = filteredUsers.map((s: any) => ({
                    name: s.name || 'Unknown',
                    id: 0,
                    timestamp: payload.timestamp || Date.now(),
                    isSpeaking: s.isSpeaking || false,
                }))

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
                    this.logSpeakersTable(speakers)
                    this.writeLogToFile(speakers)
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

    private logSpeakersTable(speakers: SpeakerData[]): void {
        if (speakers.length === 0) {
            console.log('[NetworkSpeakerLogger] No speakers detected')
            return
        }

        // Build table header
        const lines = [
            '│ name            │ id              │ timestamp       │ isSpeaking      │',
            '│ --------------- │ --------------- │ --------------- │ --------------- │',
        ]

        // Add each speaker as a row
        speakers.forEach((speaker) => {
            const name = speaker.name.padEnd(15).substring(0, 15)
            const id = String(speaker.id).padEnd(15).substring(0, 15)
            const timestamp = String(speaker.timestamp).padEnd(15).substring(0, 15)
            const isSpeaking = String(speaker.isSpeaking).padEnd(15).substring(0, 15)
            lines.push(`│ ${name} │ ${id} │ ${timestamp} │ ${isSpeaking} │`)
        })

        console.log('[NetworkSpeakerLogger] Network speakers:')
        lines.forEach((line) => console.log(line))
    }

    private async writeLogToFile(speakers: SpeakerData[]): Promise<void> {
        try {
            const logEntry = JSON.stringify(speakers)
            await fs.appendFile(this.logFilePath, `${logEntry}\n`)
        } catch (error) {
            console.error(
                '[NetworkSpeakerLogger] Cannot append network speaker log file:',
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
