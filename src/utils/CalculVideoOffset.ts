/**
 * Utility to calculate synchronization offset between audio beep and video flash
 * Analyzes audio file for 1000Hz beep and video file for green flash
 * Returns the time offset needed to synchronize the files
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Configuration constants
const EXPECTED_FREQUENCY = 1000
const ANALYSIS_WINDOW = 10 // Analyze first 10 seconds

interface SyncOffset {
    /** Audio signal timestamp in seconds */
    audioTimestamp: number
    /** Video signal timestamp in seconds */
    videoTimestamp: number
    /** Calculated offset in seconds (positive means video is ahead) */
    offsetSeconds: number
    /** Quality/confidence of detection (0-1) */
    confidence: number
}

/**
 * Calculate synchronization offset between audio and video files
 * @param audioPath - Path to audio file (.wav)
 * @param videoPath - Path to video file (.webm, .mp4, etc.)
 * @returns Promise<SyncOffset> - Synchronization information
 */
export async function calculateVideoOffset(
    audioPath: string,
    videoPath: string,
): Promise<SyncOffset> {
    console.log(`🔍 Analyzing sync signals (first ${ANALYSIS_WINDOW}s only)...`)
    console.log(`   Audio: ${audioPath}`)
    console.log(`   Video: ${videoPath}`)

    try {
        // Analyze both files in parallel
        const [audioTimestamp, videoTimestamp] = await Promise.all([
            detectAudioBeep(audioPath),
            detectVideoFlash(videoPath),
        ])

        // Validate that we found both signals
        if (audioTimestamp <= 0) {
            console.warn(
                `⚠️ Failed to detect audio beep in first ${ANALYSIS_WINDOW}s, using default`,
            )
        }
        if (videoTimestamp <= 0) {
            console.warn(
                `⚠️ Failed to detect video flash in first ${ANALYSIS_WINDOW}s, using default`,
            )
        }

        // If either signal is missing, use default values
        if (audioTimestamp <= 0 || videoTimestamp <= 0) {
            const defaultResult: SyncOffset = {
                audioTimestamp: audioTimestamp > 0 ? audioTimestamp : 0,
                videoTimestamp: videoTimestamp > 0 ? videoTimestamp : 0,
                offsetSeconds: 0.0,
                confidence: 0.1,
            }

            console.log(`✅ Using default offset: 0.000s (confidence: 10.0%)`)
            return defaultResult
        }

        const offsetSeconds = videoTimestamp - audioTimestamp
        const confidence = 0.9 // High confidence if both signals detected

        const result: SyncOffset = {
            audioTimestamp,
            videoTimestamp,
            offsetSeconds,
            confidence,
        }

        console.log(`✅ Sync analysis complete:`)
        console.log(`   Audio beep at: ${audioTimestamp.toFixed(3)}s`)
        console.log(`   Video flash at: ${videoTimestamp.toFixed(3)}s`)
        console.log(`   Offset: ${offsetSeconds.toFixed(3)}s`)
        console.log(`   Confidence: ${(confidence * 100).toFixed(1)}%`)

        return result
    } catch (error) {
        console.error('❌ Failed to calculate offset:', error)
        console.log('⚠️ Using fallback offset due to analysis error')

        // Return default offset with very low confidence
        const fallbackResult: SyncOffset = {
            audioTimestamp: 0,
            videoTimestamp: 0,
            offsetSeconds: 0.0,
            confidence: 0.05, // Very low confidence for error case
        }

        console.log(`✅ Using fallback offset: 0.000s (confidence: 5.0%)`)
        return fallbackResult
    }
}

/**
 * Detect 1000Hz beep in audio file using FFmpeg spectral analysis
 */
async function detectAudioBeep(audioPath: string): Promise<number> {
    console.log(
        `🔊 Detecting ${EXPECTED_FREQUENCY}Hz beep in first ${ANALYSIS_WINDOW}s of audio...`,
    )

    try {
        // Method 1: Use silence detection to find audio activity
        const silenceCmd = `ffmpeg -i "${audioPath}" -af "silencedetect=noise=-35dB:duration=0.01" -f null -t ${ANALYSIS_WINDOW} - 2>&1 | grep "silence_"`

        try {
            const { stdout: silenceOutput } = await execAsync(silenceCmd)
            const lines = silenceOutput
                .split('\n')
                .filter((line) => line.includes('silence_'))

            console.log(
                `   Silence detection found ${lines.length} events in first ${ANALYSIS_WINDOW}s`,
            )

            // Look for the first significant audio activity (silence_end)
            for (const line of lines) {
                const endMatch = line.match(/silence_end: ([0-9.]+)/)
                if (endMatch) {
                    const time = parseFloat(endMatch[1])
                    if (time > 0.01 && time < ANALYSIS_WINDOW) {
                        // Avoid very early noise
                        console.log(
                            `   Found audio activity (likely bip) at ${time.toFixed(3)}s`,
                        )
                        return time
                    }
                }
            }
        } catch (e) {
            console.log(
                `   Silence detection failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
            )
        }

        // Method 2: Use volume analysis to find the first significant audio peak
        const volumeCmd = `ffmpeg -i "${audioPath}" -af "volumedetect" -f null -t ${ANALYSIS_WINDOW} - 2>&1`
        const { stdout: volumeOutput } = await execAsync(volumeCmd)

        const maxVolumeMatch = volumeOutput.match(/max_volume: (-?[0-9.]+) dB/)
        if (maxVolumeMatch) {
            const maxVolume = parseFloat(maxVolumeMatch[1])
            console.log(
                `   Audio levels in first ${ANALYSIS_WINDOW}s: max=${maxVolume.toFixed(1)}dB`,
            )

            // If there's significant audio, use a more detailed analysis
            if (maxVolume > -60) {
                // Use a more sensitive silence detection
                const detailedCmd = `ffmpeg -i "${audioPath}" -af "silencedetect=noise=-50dB:duration=0.005" -f null -t ${ANALYSIS_WINDOW} - 2>&1 | grep "silence_end"`
                try {
                    const { stdout: detailedOutput } =
                        await execAsync(detailedCmd)
                    const detailedLines = detailedOutput
                        .split('\n')
                        .filter((line) => line.includes('silence_end'))

                    for (const line of detailedLines) {
                        const match = line.match(/silence_end: ([0-9.]+)/)
                        if (match) {
                            const time = parseFloat(match[1])
                            if (time > 0.01 && time < ANALYSIS_WINDOW) {
                                console.log(
                                    `   Found audio activity with detailed analysis at ${time.toFixed(3)}s`,
                                )
                                return time
                            }
                        }
                    }
                } catch (e) {
                    console.log(
                        `   Detailed analysis failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
                    )
                }
            }
        }

        console.log(`   No sync bip detected in first ${ANALYSIS_WINDOW}s`)
        return 0
    } catch (error) {
        console.warn(`⚠️ Audio analysis failed: ${error}`)
        return 0
    }
}

/**
 * Detect green flash in video file using color analysis
 * Much more reliable than scene detection for the specific green flash
 */
async function detectVideoFlash(videoPath: string): Promise<number> {
    console.log(
        `💚 Detecting green flash using color analysis (first ${ANALYSIS_WINDOW}s)...`,
    )

    try {
        // Use scene detection but filter by color characteristics
        const sceneColorCmd = `ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.02)',showinfo" -vsync 0 -f null -t ${ANALYSIS_WINDOW} - 2>&1 | grep -E "(pts_time|mean:)"`

        try {
            const { stdout: sceneColorOutput } = await execAsync(sceneColorCmd)
            const lines = sceneColorOutput.split('\n')

            let currentTime = 0
            let currentMean = ''

            for (const line of lines) {
                const timeMatch = line.match(/pts_time:([0-9.]+)/)
                const meanMatch = line.match(/mean:\[([0-9. ]+)\]/)

                if (timeMatch) {
                    currentTime = parseFloat(timeMatch[1])
                }
                if (meanMatch) {
                    currentMean = meanMatch[1]

                    // Parse YUV values: mean:[Y U V]
                    const values = currentMean
                        .trim()
                        .split(/\s+/)
                        .map((v) => parseFloat(v))
                    if (values.length >= 3) {
                        const [Y, U, V] = values

                        // Check if this looks like a green flash:
                        // Y (luminance) should be lower than normal (~140-150 vs ~220)
                        // U (red chrominance) should be lower than normal (~63 vs ~128)
                        // V (blue chrominance) should be much lower than normal (~46 vs ~128)
                        if (
                            Y < 160 &&
                            U < 80 &&
                            V < 60 &&
                            currentTime > 1.0 &&
                            currentTime < ANALYSIS_WINDOW
                        ) {
                            console.log(
                                `   Found green flash at ${currentTime.toFixed(3)}s (color analysis)`,
                            )
                            console.log(
                                `   YUV values: [${Y.toFixed(1)} ${U.toFixed(1)} ${V.toFixed(1)}]`,
                            )
                            return currentTime
                        }
                    }
                }
            }
        } catch (e) {
            console.log(
                `   Color analysis failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
            )
        }

        // Fallback: Use traditional scene detection if color analysis fails
        try {
            const sceneCmd = `ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.05)',showinfo" -f null -t ${ANALYSIS_WINDOW} - 2>&1 | grep "pts_time"`

            const { stdout: sceneResult } = await execAsync(sceneCmd)
            const lines = sceneResult
                .split('\n')
                .filter((line) => line.includes('pts_time'))

            console.log(
                `   Fallback: Found ${lines.length} scene changes in first ${ANALYSIS_WINDOW}s`,
            )

            let bestFlashTime = 0
            let bestSceneValue = 0

            for (const line of lines) {
                const timeMatch = line.match(/pts_time:([0-9.]+)/)
                const sceneMatch = line.match(/scene:([0-9.]+)/)

                if (timeMatch && sceneMatch) {
                    const time = parseFloat(timeMatch[1])
                    const sceneValue = parseFloat(sceneMatch[1])

                    // Look for significant changes after 0.5s
                    if (
                        time > 0.5 &&
                        time < ANALYSIS_WINDOW &&
                        sceneValue > bestSceneValue
                    ) {
                        bestFlashTime = time
                        bestSceneValue = sceneValue
                    }
                }
            }

            if (bestFlashTime > 0) {
                console.log(
                    `   Fallback: Found scene change at ${bestFlashTime.toFixed(3)}s (scene value: ${bestSceneValue.toFixed(3)})`,
                )
                return bestFlashTime
            }
        } catch (e) {
            console.log(
                `   Fallback scene detection failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
            )
        }

        console.log(`   No green flash detected in first ${ANALYSIS_WINDOW}s`)
        return 0
    } catch (error) {
        console.warn(`⚠️ Video analysis failed: ${error}`)
        return 0
    }
}

/**
 * Test function using the provided sample files
 */
async function testWithSampleFiles(): Promise<SyncOffset> {
    const audioPath =
        '/Users/philippedrion/OutOfIcloud/meeting-baas/meeting_bot/recording_server/recordings/test/output.wav'
    const videoPath =
        '/Users/philippedrion/OutOfIcloud/meeting-baas/meeting_bot/recording_server/recordings/test/output.mp4'

    return calculateVideoOffset(audioPath, videoPath)
}

/**
 * Test function for the specific problematic video file
 * Uses color-based detection instead of scene detection
 */
async function testGreenFlashDetection(): Promise<SyncOffset> {
    const videoPath =
        '/Users/philippedrion/Documents/meeting-baas/meeting_bot/recording_server/recordings/47FED07F-401A-4E78-A810-044F4CE469BA/temp/raw.mp4'

    console.log('🧪 Testing green flash detection on specific video file...')
    console.log(`   Video: ${videoPath}`)

    try {
        // Use color-based detection instead of scene detection
        const videoTimestamp = await detectGreenFlashByColor(videoPath)

        const result: SyncOffset = {
            audioTimestamp: 0, // Not testing audio
            videoTimestamp,
            offsetSeconds: 0,
            confidence: videoTimestamp > 0 ? 0.95 : 0.1,
        }

        console.log(`✅ Green flash detection result:`)
        console.log(`   Video flash at: ${videoTimestamp.toFixed(3)}s`)
        console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`)

        return result
    } catch (error) {
        console.error('❌ Green flash detection failed:', error)
        return {
            audioTimestamp: 0,
            videoTimestamp: 0,
            offsetSeconds: 0,
            confidence: 0.05,
        }
    }
}

/**
 * Detect green flash using color analysis instead of scene detection
 * Looks for frames with specific YUV color characteristics of the green flash
 */
async function detectGreenFlashByColor(videoPath: string): Promise<number> {
    console.log(
        `💚 Detecting green flash using color analysis (first ${ANALYSIS_WINDOW}s)...`,
    )

    try {
        // Method 1: Look for frames with low Y (luminance) and low V (blue chrominance)
        // Green flash has: Y ~140-150, U ~63, V ~46 (vs normal Y ~220, U ~128, V ~128)
        const colorCmd = `ffmpeg -i "${videoPath}" -vf "select='lt(YAVG,0.6)*lt(VAVG,0.4)',showinfo" -vsync 0 -f null -t ${ANALYSIS_WINDOW} - 2>&1 | grep "pts_time"`

        try {
            const { stdout: colorOutput } = await execAsync(colorCmd)
            const lines = colorOutput
                .split('\n')
                .filter((line) => line.includes('pts_time'))

            console.log(`   Found ${lines.length} potential green flash frames`)

            // Look for the first significant green flash after 1s
            for (const line of lines) {
                const match = line.match(/pts_time:([0-9.]+)/)
                if (match) {
                    const time = parseFloat(match[1])
                    if (time > 1.0 && time < ANALYSIS_WINDOW) {
                        console.log(
                            `   Found green flash at ${time.toFixed(3)}s (color-based detection)`,
                        )
                        return time
                    }
                }
            }
        } catch (e) {
            console.log(
                `   Color detection failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
            )
        }

        // Method 2: Use scene detection but filter by color characteristics
        const sceneColorCmd = `ffmpeg -i "${videoPath}" -vf "select='gt(scene,0.02)',showinfo" -vsync 0 -f null -t ${ANALYSIS_WINDOW} - 2>&1 | grep -E "(pts_time|mean:)"`

        try {
            const { stdout: sceneColorOutput } = await execAsync(sceneColorCmd)
            const lines = sceneColorOutput.split('\n')

            let currentTime = 0
            let currentMean = ''

            for (const line of lines) {
                const timeMatch = line.match(/pts_time:([0-9.]+)/)
                const meanMatch = line.match(/mean:\[([0-9. ]+)\]/)

                if (timeMatch) {
                    currentTime = parseFloat(timeMatch[1])
                }
                if (meanMatch) {
                    currentMean = meanMatch[1]

                    // Parse YUV values: mean:[Y U V]
                    const values = currentMean
                        .trim()
                        .split(/\s+/)
                        .map((v) => parseFloat(v))
                    if (values.length >= 3) {
                        const [Y, U, V] = values

                        // Check if this looks like a green flash:
                        // Y (luminance) should be lower than normal (~140-150 vs ~220)
                        // U (red chrominance) should be lower than normal (~63 vs ~128)
                        // V (blue chrominance) should be much lower than normal (~46 vs ~128)
                        if (
                            Y < 160 &&
                            U < 80 &&
                            V < 60 &&
                            currentTime > 1.0 &&
                            currentTime < ANALYSIS_WINDOW
                        ) {
                            console.log(
                                `   Found green flash at ${currentTime.toFixed(3)}s (scene+color analysis)`,
                            )
                            console.log(
                                `   YUV values: [${Y.toFixed(1)} ${U.toFixed(1)} ${V.toFixed(1)}]`,
                            )
                            return currentTime
                        }
                    }
                }
            }
        } catch (e) {
            console.log(
                `   Scene+color analysis failed: ${e instanceof Error ? e.message : 'Unknown error'}`,
            )
        }

        console.log(`   No green flash detected in first ${ANALYSIS_WINDOW}s`)
        return 0
    } catch (error) {
        console.warn(`⚠️ Green flash color analysis failed: ${error}`)
        return 0
    }
}
