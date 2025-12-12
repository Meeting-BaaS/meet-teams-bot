import * as fs from 'fs'
import { PathManager } from './PathManager'
import { formatError } from './Logger'

const RMS_THRESHOLD = 0.005 // 0.5%
const RMS_TO_LEVEL_SCALE = 300

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

    /**
     * Check if an instance exists without creating one
     * Useful for cleanup to avoid side effects
     */
    public static peekInstance(): SoundLevelMonitor | null {
        return SoundLevelMonitor.instance
    }

    /**
     * Stop the monitor if it exists, without creating an instance
     * Safe to call during cleanup even if monitor was never started
     */
    public static stopIfStarted(): void {
        if (SoundLevelMonitor.instance) {
            SoundLevelMonitor.instance.stop()
        }
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
        this.currentSoundLevel = 0 // Reset to avoid stale readings
        this.audioBuffer = []
        console.log('🎵 Sound level monitor stopped')
    }

    /**
     * Check if the monitor is currently active
     * Useful for determining if sound level readings are valid
     */
    public getIsActive(): boolean {
        return this.isActive
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
            // Snapshot the batch before async processing to avoid race conditions
            const batch = this.audioBuffer
            this.audioBuffer = []
            
            this.processBatchedAudio(batch).catch((error) =>
                console.error(
                    '[SoundLevelMonitor] Error processing batched audio:',
                    formatError(error),
                ),
            )
        }
    }

    private async processBatchedAudio(batch: Float32Array[]): Promise<void> {
        if (batch.length === 0) return

        // Combine all audio buffers into one for analysis
        const totalLength = batch.reduce(
            (sum, buffer) => sum + buffer.length,
            0,
        )
        const combinedBuffer = new Float32Array(totalLength)

        let offset = 0
        for (const buffer of batch) {
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
            normalizedLevel = Math.min(100, rms * RMS_TO_LEVEL_SCALE)
        }

        // Update current level for real-time monitoring
        this.currentSoundLevel = normalizedLevel

        // Throttled file logging
        const now = Date.now()
        if (now - this.lastSoundLogTime >= this.SOUND_LOG_INTERVAL_MS) {
            const timestamp = new Date(now).toISOString()
            const logEntry = `${timestamp},${normalizedLevel.toFixed(0)}\n`

            const soundLogPath = PathManager.getInstance().getSoundLogPath()
            // Silently handle file errors
            await fs.promises.appendFile(soundLogPath, logEntry).catch(() => {})
            this.lastSoundLogTime = now
        }
    }

    public getCurrentSoundLevel(): number {
        return this.currentSoundLevel
    }
}

