import * as fs from 'fs'
import { PathManager } from './PathManager'
import { formatError } from './Logger'

const RMS_THRESHOLD = 0.005 // 0.5%

/**
 * Independent sound level monitor for automatic leave conditions
 * Reads audio from FFmpeg stdout and analyzes sound levels
 * Completely separate from streaming functionality
 * 
 * This ensures automatic leave detection works reliably regardless of
 * streaming configuration or WebSocket connection state.
 */
export class SoundLevelMonitor {
    private static instance: SoundLevelMonitor | null = null

    private currentSoundLevel: number = 0
    private lastSoundLogTime: number = 0
    private readonly SOUND_LOG_INTERVAL_MS: number = 5000
    private audioBuffer: Float32Array[] = []
    private readonly AUDIO_BUFFER_SIZE: number = 12
    private isActive: boolean = false

    private constructor() {}

    public static getInstance(): SoundLevelMonitor {
        if (!SoundLevelMonitor.instance) {
            SoundLevelMonitor.instance = new SoundLevelMonitor()
        }
        return SoundLevelMonitor.instance
    }

    public start(): void {
        this.isActive = true
        this.currentSoundLevel = 0
        this.audioBuffer = []
        console.log(
            '🎵 Sound level monitor started (for automatic leave detection)',
        )
    }

    public stop(): void {
        this.isActive = false
        this.audioBuffer = []
        console.log('🎵 Sound level monitor stopped')
    }

    /**
     * Process audio chunk from FFmpeg stdout
     * Called by ScreenRecorder when audio data is available
     */
    public processAudioChunk(audioData: Float32Array): void {
        if (!this.isActive) {
            return
        }

        // Buffer audio for batch processing
        this.audioBuffer.push(audioData)
        if (this.audioBuffer.length >= this.AUDIO_BUFFER_SIZE) {
            this.processBatchedAudio().catch((error) =>
                console.error(
                    '[SoundLevelMonitor] Error processing batched audio:',
                    formatError(error),
                ),
            )
            this.audioBuffer = []
        }
    }

    private async processBatchedAudio(): Promise<void> {
        if (this.audioBuffer.length === 0) return

        // Combine all audio buffers into one for analysis
        const totalLength = this.audioBuffer.reduce(
            (sum, buffer) => sum + buffer.length,
            0,
        )
        const combinedBuffer = new Float32Array(totalLength)

        let offset = 0
        for (const buffer of this.audioBuffer) {
            combinedBuffer.set(buffer, offset)
            offset += buffer.length
        }

        // Analyze the combined buffer
        await this.analyzeSoundLevel(combinedBuffer)
    }

    private async analyzeSoundLevel(audioData: Float32Array): Promise<void> {
        // Apply adaptive sampling to reduce computational load
        const sampleRate = audioData.length > 2000 ? 16 : 8
        const sampledLength = Math.floor(audioData.length / sampleRate)

        // Skip analysis for very small buffers
        if (sampledLength < 10) {
            return
        }

        let sum = 0

        // Calculate RMS (Root Mean Square)
        for (let i = 0; i < sampledLength; i++) {
            const value = audioData[i * sampleRate]
            sum += value * value
        }

        const rms = Math.sqrt(sum / sampledLength)

        // Calculate normalized sound level
        let normalizedLevel = 0
        if (rms > RMS_THRESHOLD) {
            normalizedLevel = Math.min(100, rms * 300)
        }

        // Update current level for real-time monitoring
        this.currentSoundLevel = normalizedLevel

        // Throttled file logging
        const now = Date.now()
        if (now - this.lastSoundLogTime >= this.SOUND_LOG_INTERVAL_MS) {
            const timestamp = new Date(now).toISOString()
            const logEntry = `${timestamp},${normalizedLevel.toFixed(0)}\n`

            try {
                const soundLogPath = PathManager.getInstance().getSoundLogPath()
                await fs.promises.appendFile(soundLogPath, logEntry).catch(() => {})
                this.lastSoundLogTime = now
            } catch (error) {
                // Silently handle file errors
            }
        }
    }

    public getCurrentSoundLevel(): number {
        return this.currentSoundLevel
    }

    public reset(): void {
        this.currentSoundLevel = 0
        this.audioBuffer = []
        this.isActive = false
        SoundLevelMonitor.instance = null
    }
}

