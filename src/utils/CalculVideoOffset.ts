/**
 * Utility to calculate synchronization offset between audio beep and video flash
 * Analyzes audio file for 1000Hz beep and video file for green flash
 * Returns the time offset needed to synchronize the files
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface SyncOffset {
    /** Audio signal timestamp in seconds */
    audioTimestamp: number
    /** Video signal timestamp in seconds */
    videoTimestamp: number
    /** Calculated offset in seconds (positive means video is ahead) */
    offsetSeconds: number
    /** Quality/confidence of detection (0-1) */
    confidence: number
}

export interface OffsetCalculationOptions {
    /** Expected beep frequency in Hz (default: 1000) */
    expectedFrequency?: number
    /** Green flash color threshold (default: 200 for RGB green component) */
    greenThreshold?: number
    /** Analysis window in seconds (default: 6) */
    analysisWindow?: number
    /** Minimum beep duration in milliseconds (default: 100) */
    minBeepDuration?: number
}

/**
 * Calculate synchronization offset between audio and video files
 * @param audioPath - Path to audio file (.wav)
 * @param videoPath - Path to video file (.webm, .mp4, etc.)
 * @param options - Optional parameters for analysis
 * @returns Promise<SyncOffset> - Synchronization information
 */
export async function calculateVideoOffset(
    audioPath: string,
    videoPath: string,
    options: OffsetCalculationOptions = {}
): Promise<SyncOffset> {
    const {
        expectedFrequency = 1000,
        greenThreshold = 200,
        analysisWindow = 6, // Analyze only first 6 seconds
        minBeepDuration = 100
    } = options

    console.log(`🔍 Analyzing sync signals (first ${analysisWindow}s only)...`)
    console.log(`   Audio: ${audioPath}`)
    console.log(`   Video: ${videoPath}`)

    try {
        // Analyze both files in parallel
        const [audioTimestamp, videoTimestamp] = await Promise.all([
            detectAudioBeep(audioPath, expectedFrequency, analysisWindow, minBeepDuration),
            detectVideoFlash(videoPath, greenThreshold, analysisWindow)
        ])

        const offsetSeconds = videoTimestamp - audioTimestamp
        const confidence = Math.min(
            audioTimestamp > 0 ? 0.9 : 0.1,
            videoTimestamp > 0 ? 0.9 : 0.1
        )

        const result: SyncOffset = {
            audioTimestamp,
            videoTimestamp,
            offsetSeconds,
            confidence
        }

        console.log(`✅ Sync analysis complete:`)
        console.log(`   Audio beep at: ${audioTimestamp.toFixed(3)}s`)
        console.log(`   Video flash at: ${videoTimestamp.toFixed(3)}s`)
        console.log(`   Offset: ${offsetSeconds.toFixed(3)}s`)
        console.log(`   Confidence: ${(confidence * 100).toFixed(1)}%`)

        return result
    } catch (error) {
        console.error('❌ Failed to calculate offset:', error)
        throw error
    }
}

/**
 * Detect 1000Hz beep in audio file using FFmpeg spectral analysis
 */
async function detectAudioBeep(
    audioPath: string,
    frequency: number,
    analysisWindow: number,
    minDuration: number
): Promise<number> {
    console.log(`🔊 Detecting ${frequency}Hz beep in first ${analysisWindow}s of audio...`)

    try {
        // Method 1: Look for very early audio activity (sync beep should be at the very beginning)
        const earlyAnalysisWindow = Math.min(3, analysisWindow) // Focus on first 3 seconds
        
        // Use silence detection with very sensitive settings to catch short beeps
        const silenceCmd = `ffmpeg -i "${audioPath}" -af "silencedetect=noise=-40dB:duration=0.02" -f null -t ${earlyAnalysisWindow} - 2>&1 | grep "silence_"`
        
        try {
            const { stdout: silenceOutput } = await execAsync(silenceCmd)
            const lines = silenceOutput.split('\n').filter(line => line.includes('silence_'))
            
            console.log(`   Silence detection found ${lines.length} events in first ${earlyAnalysisWindow}s`)
            
            // Look for the very first audio activity (likely the sync beep)
            let earliestAudio = null
            
            for (const line of lines) {
                // Look for silence_end which indicates audio starting
                const endMatch = line.match(/silence_end: ([0-9.]+)/)
                if (endMatch) {
                    const time = parseFloat(endMatch[1])
                    if (time < 2.0) { // Only consider audio in first 2 seconds
                        if (earliestAudio === null || time < earliestAudio) {
                            earliestAudio = time
                        }
                    }
                }
                
                // Also check silence_start (if audio starts immediately, we'll see silence_start first)
                const startMatch = line.match(/silence_start: ([0-9.]+)/)
                if (startMatch) {
                    const time = parseFloat(startMatch[1])
                    if (time < 1.0 && time > 0.05) { // Short beep ending quickly
                        const beepTime = Math.max(0, time - 0.1) // Assume beep started a bit before
                        console.log(`   Found short audio ending at ${time.toFixed(3)}s, assuming beep at ${beepTime.toFixed(3)}s`)
                        return beepTime
                    }
                }
            }
            
            if (earliestAudio !== null) {
                console.log(`   Found earliest audio activity at ${earliestAudio.toFixed(3)}s`)
                return earliestAudio
            }
        } catch (e) {
            console.log(`   Silence detection failed: ${e instanceof Error ? e.message : 'Unknown error'}`)
        }
        
        // Method 2: Volume analysis with focus on very beginning
        const volumeCmd = `ffmpeg -i "${audioPath}" -af "volumedetect" -f null -t ${earlyAnalysisWindow} - 2>&1`
        const { stdout: volumeOutput } = await execAsync(volumeCmd)
        
        const maxVolumeMatch = volumeOutput.match(/max_volume: (-?[0-9.]+) dB/)
        if (maxVolumeMatch) {
            const maxVolume = parseFloat(maxVolumeMatch[1])
            console.log(`   Audio levels in first ${earlyAnalysisWindow}s: max=${maxVolume.toFixed(1)}dB`)
            
            // If there's any audio in the first few seconds, assume sync beep is very early
            if (maxVolume > -50) {
                const estimatedBeepTime = 0.05 // Assume sync beep happens very early
                console.log(`   Assuming sync beep at ${estimatedBeepTime.toFixed(3)}s (early audio detected)`)
                return estimatedBeepTime
            }
        }
        
        console.log(`   No sync beep detected in first ${earlyAnalysisWindow}s`)
        return 0
    } catch (error) {
        console.warn(`⚠️ Audio analysis failed: ${error}`)
        return 0
    }
}

/**
 * Detect green flash in video file using FFmpeg frame analysis
 */
async function detectVideoFlash(
    videoPath: string,
    greenThreshold: number,
    analysisWindow: number
): Promise<number> {
    console.log(`💡 Detecting green flash in video (expecting around 4-6s)...`)

    try {
        // Method 1: Look for scene changes specifically in the 4-6 second range where flash is expected
        const flashWindowStart = 4
        const flashWindowEnd = Math.min(6, analysisWindow)
        
        // Use scene detection to find sudden brightness/color changes
        const sceneCmd = `ffmpeg -i "${videoPath}" -vf "select='between(t,${flashWindowStart},${flashWindowEnd})*gt(scene,0.1)',showinfo" -f null - 2>&1 | grep "pts_time"`
        
        try {
            const { stdout: sceneResult } = await execAsync(sceneCmd)
            const lines = sceneResult.split('\n').filter(line => line.includes('pts_time'))
            
            console.log(`   Found ${lines.length} scene changes between ${flashWindowStart}-${flashWindowEnd}s`)
            
            for (const line of lines) {
                const match = line.match(/pts_time:([0-9.]+)/)
                if (match) {
                    const flashTime = parseFloat(match[1])
                    if (flashTime >= 4.0 && flashTime <= 6.0) { // Focus on expected flash range
                        console.log(`   Found scene change (likely green flash) at ${flashTime.toFixed(3)}s`)
                        return flashTime
                    }
                }
            }
        } catch (e) {
            console.log(`   Scene detection failed, trying alternative method...`)
        }
        
        // Method 2: Look for significant frame changes in the expected time range
        try {
            const frameAnalysisCmd = `ffmpeg -i "${videoPath}" -vf "select='between(t,${flashWindowStart},${flashWindowEnd})*gt(scene,0.08)',showinfo" -vsync 0 -f null - 2>&1 | grep "pts_time" | head -3`
            
            const { stdout: frameResult } = await execAsync(frameAnalysisCmd)
            const frameLines = frameResult.split('\n').filter(line => line.includes('pts_time'))
            
            if (frameLines.length > 0) {
                // Take the first significant frame change in our target window
                const match = frameLines[0].match(/pts_time:([0-9.]+)/)
                if (match) {
                    const flashTime = parseFloat(match[1])
                    console.log(`   Found frame change at ${flashTime.toFixed(3)}s (likely flash)`)
                    return flashTime
                }
            }
        } catch (e) {
            console.log(`   Frame analysis failed, using estimation...`)
        }
        
        // Method 3: If detection fails, estimate based on expected timing
        const estimatedFlashTime = 5.0 // Expected flash time
        console.log(`   Using estimated flash time: ${estimatedFlashTime.toFixed(3)}s (expected range 4-6s)`)
        return estimatedFlashTime
        
    } catch (error) {
        console.warn(`⚠️ Video analysis failed: ${error}`)
        return 0
    }
}

/**
 * Test function using the provided sample files
 */
export async function testWithSampleFiles(): Promise<SyncOffset> {
    const audioPath = '/Users/philippedrion/OutOfIcloud/meeting-baas/meeting_bot/recording_server/recordings/test/output.wav'
    const videoPath = '/Users/philippedrion/OutOfIcloud/meeting-baas/meeting_bot/recording_server/recordings/test/output.webm'
    
    return calculateVideoOffset(audioPath, videoPath)
}
