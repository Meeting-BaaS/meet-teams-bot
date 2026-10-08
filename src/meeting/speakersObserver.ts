import { Page } from '@playwright/test'
import { MeetingProvider, RecordingMode, SpeakerData } from '../types'
import { MeetSpeakersObserver } from './meet/speakersObserver'
import { TeamsSpeakersObserver } from './teams/speakersObserver'

export class SpeakersObserver {
    private meetingProvider: MeetingProvider
    private observer: MeetSpeakersObserver | TeamsSpeakersObserver | null = null
    private isObserving: boolean = false
    private readonly maxRetries = 3
    private startup?: Promise<void>
    private stopping?: Promise<void>
    private generation = 0
    private cancelRetry?: () => void

    constructor(meetingProvider: MeetingProvider) {
        this.meetingProvider = meetingProvider
    }

    public async startObserving(
        page: Page,
        recordingMode: RecordingMode,
        botName: string,
        onSpeakersChange: (speakers: SpeakerData[]) => void,
    ): Promise<void> {
        if (this.stopping) await this.stopping
        if (this.startup) return this.startup
        if (this.isObserving) {
            console.warn('[SpeakersObserver] Already running')
            return
        }

        console.log(
            `[SpeakersObserver] Starting for ${this.meetingProvider}...`,
        )

        // Create the appropriate observer based on meeting provider - SIMPLE ROUTING
        switch (this.meetingProvider) {
            case 'Meet':
                this.observer = new MeetSpeakersObserver(
                    page,
                    recordingMode,
                    botName,
                    onSpeakersChange,
                )
                break

            case 'Teams':
                this.observer = new TeamsSpeakersObserver(
                    page,
                    recordingMode,
                    botName,
                    onSpeakersChange,
                )
                break

            default:
                throw new Error(
                    `Unknown meeting provider: ${this.meetingProvider}`,
                )
        }

        const observer = this.observer!
        const generation = ++this.generation
        const startup = this.startWithRetries(observer, generation)
            .then(() => {
                if (generation !== this.generation || !this.isObserving) {
                    throw new Error('Observer startup cancelled')
                }
            })
            .finally(() => {
                if (this.startup === startup) this.startup = undefined
            })
        this.startup = startup
        return startup
    }

    private async startWithRetries(
        observer: MeetSpeakersObserver | TeamsSpeakersObserver,
        generation: number,
    ): Promise<void> {
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                if (generation !== this.generation)
                    throw new Error('Observer startup cancelled')
                await observer.startObserving()
                if (generation !== this.generation)
                    throw new Error('Observer startup cancelled')
                this.isObserving = true
                console.log(
                    `[SpeakersObserver] ✅ Started for ${this.meetingProvider}`,
                )
                return
            } catch (error) {
                await this.stopObserver(observer)
                if (generation !== this.generation) throw error
                console.warn(
                    `[SpeakersObserver] Failed to initialize (attempt ${attempt + 1}/${this.maxRetries + 1}):`,
                    error,
                )
                if (attempt === this.maxRetries) {
                    this.isObserving = false
                    this.observer = null
                    throw error
                }
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                        this.cancelRetry = undefined
                        resolve()
                    }, 5000)
                    this.cancelRetry = () => {
                        clearTimeout(timer)
                        this.cancelRetry = undefined
                        resolve()
                    }
                })
            }
        }
    }

    private async stopObserver(
        observer: MeetSpeakersObserver | TeamsSpeakersObserver | null,
    ): Promise<void> {
        try {
            await observer?.stopObserving()
        } catch (error) {
            // Cleanup must neither mask a startup failure nor reject an
            // intentionally fire-and-forget stop from the pause path.
            console.warn('[SpeakersObserver] Cleanup failed:', error)
        }
    }

    public stopObserving(): Promise<void> {
        if (this.stopping) return this.stopping
        ++this.generation
        this.cancelRetry?.()
        const observer = this.observer
        this.observer = null
        this.isObserving = false
        const stopping = Promise.all([
            this.stopObserver(observer),
            this.startup?.catch(() => {}),
        ])
            .then(() => {})
            .finally(() => {
                if (this.stopping === stopping) this.stopping = undefined
            })
        this.stopping = stopping
        return stopping
    }

    public isCurrentlyObserving(): boolean {
        return this.isObserving
    }
}
