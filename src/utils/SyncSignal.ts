/**
 * Utility function to generate audio-visual sync signal for recordings
 * Generates a 1000Hz beep + green flash for synchronization purposes
 */

import { spawn } from 'child_process'
import { Page } from 'playwright'
import { formatError } from './Logger'

interface SyncSignalOptions {
    /** Duration of the sync signal in milliseconds (default: 500) */
    duration?: number
    /** Audio frequency in Hz (default: 1000) */
    frequency?: number
    /** Flash color (default: '#00FF00' - bright green) */
    flashColor?: string
    /** Audio volume (0-1, default: 0.9) */
    volume?: number
}

/**
 * Generate synchronization signal on the given page
 * @param page - Playwright page instance
 * @param options - Optional configuration for the sync signal
 */
export async function generateSyncSignal(
    page: Page,
    options: SyncSignalOptions = {},
): Promise<void> {
    const {
        duration = 150,
        frequency = 1000,
        flashColor = '#00FF00',
        volume = 0.9,
    } = options

    console.log(
        `🎯 Generating sync signal: ${frequency}Hz beep + flash (${duration}ms)`,
    )

    try {
        // Fire the audio beep and visual flash simultaneously.
        //
        // We emit the beep TWO ways on purpose:
        //  - generateAudioBeep (WebAudio, in-page) is the primary TIMING
        //    reference: it is tightly coupled to the flash paint, so the measured
        //    A/V offset reflects real capture skew, not process-spawn jitter.
        //  - generateCapturedAudioBeep injects the tone straight into the captured
        //    PulseAudio sink (ffmpeg|pacat) so a detectable beep is GUARANTEED even
        //    when the meeting page suppresses WebAudio (the no-branding / no-camera
        //    join path, where the beep was silently missed before). It double-spawns,
        //    so it lands a spawn-latency after the flash — acceptable for a fallback.
        //
        // The post-hoc detector returns the earliest activity in the search window,
        // so WebAudio wins when present (tight timing) and the injected tone — which
        // sits in the trimmed-off pre-meeting region — only takes over when WebAudio
        // is absent. Injection failure is non-fatal: the WebAudio beep already fired.
        await Promise.all([
            generateAudioBeep(page, frequency, duration, volume),
            generateCapturedAudioBeep(frequency, duration, volume),
            generateVisualFlash(page, flashColor, duration),
        ])

        console.log('✅ Sync signal generated successfully')
    } catch (error) {
        console.error('❌ Failed to generate sync signal:', formatError(error))
        throw error
    }
}

// Inject the sync tone directly into the captured PulseAudio speaker sink so a
// detectable beep is always present in the recorded audio, independent of the
// meeting page's WebAudio state. Runs ALONGSIDE the WebAudio beep (the primary
// timing reference), so a failure here is non-fatal — the WebAudio beep has
// already fired in the same Promise.all.
async function generateCapturedAudioBeep(
    frequency: number,
    duration: number,
    volume: number,
): Promise<void> {
    const speakerSink = getVirtualSpeakerSink()
    if (!speakerSink) {
        console.warn(
            '⚠️ Virtual speaker sink not resolved — skipping recorder-owned sync tone (WebAudio beep still fired)',
        )
        return
    }

    try {
        await generatePulseAudioBeep(speakerSink, frequency, duration, volume)
    } catch (error) {
        console.warn(
            '⚠️ PulseAudio sync tone failed (WebAudio beep still fired):',
            formatError(error),
        )
    }
}

function getVirtualSpeakerSink(): string | undefined {
    if (process.env.VIRTUAL_SPEAKER) {
        return process.env.VIRTUAL_SPEAKER
    }

    if (process.env.PULSE_SINK) {
        return process.env.PULSE_SINK
    }

    const monitor = process.env.VIRTUAL_SPEAKER_MONITOR
    if (monitor?.endsWith('.monitor')) {
        return monitor.slice(0, -'.monitor'.length)
    }

    return undefined
}

function generatePulseAudioBeep(
    speakerSink: string,
    frequency: number,
    duration: number,
    volume: number,
): Promise<void> {
    const durationSeconds = Math.max(0.01, duration / 1000)
    const ffmpegArgs = [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${frequency}:duration=${durationSeconds}:sample_rate=44100`,
        '-af',
        `volume=${volume}`,
        '-f',
        's16le',
        '-ac',
        '1',
        '-ar',
        '44100',
        '-',
    ]
    const pacatArgs = [
        '--playback',
        `--device=${speakerSink}`,
        '--format=s16le',
        '--channels=1',
        '--rate=44100',
        '--raw',
    ]

    console.log(
        `🔊 PulseAudio sync beep: ${frequency}Hz for ${duration}ms on ${speakerSink} via pacat`,
    )

    return new Promise((resolve, reject) => {
        const env = {
            ...process.env,
            XDG_RUNTIME_DIR:
                process.env.XDG_RUNTIME_DIR || '/root/.config/pulse',
            PULSE_RUNTIME_PATH:
                process.env.PULSE_RUNTIME_PATH ||
                process.env.XDG_RUNTIME_DIR ||
                '/root/.config/pulse',
        }
        const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const pacat = spawn('pacat', pacatArgs, {
            env,
            stdio: ['pipe', 'ignore', 'pipe'],
        })
        let ffmpegStderr = ''
        let pacatStderr = ''
        let ffmpegExitCode: number | null = null
        let pacatExitCode: number | null = null
        let settled = false

        ffmpeg.stdout?.pipe(pacat.stdin!)

        const timeout = setTimeout(() => {
            ffmpeg.kill('SIGTERM')
            pacat.kill('SIGTERM')
            finish(
                new Error(`PulseAudio sync beep timed out after ${duration + 3000}ms`),
            )
        }, duration + 3000)

        const finish = (error?: Error) => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(timeout)
            if (error) {
                reject(error)
                return
            }
            resolve()
        }

        const maybeFinish = () => {
            if (ffmpegExitCode === null || pacatExitCode === null) {
                return
            }

            if (ffmpegExitCode !== 0 || pacatExitCode !== 0) {
                finish(
                    new Error(
                        [
                            `PulseAudio sync beep failed: ffmpeg=${ffmpegExitCode}, pacat=${pacatExitCode}`,
                            ffmpegStderr.trim() &&
                                `ffmpeg stderr: ${ffmpegStderr.trim()}`,
                            pacatStderr.trim() &&
                                `pacat stderr: ${pacatStderr.trim()}`,
                        ]
                            .filter(Boolean)
                            .join('; '),
                    ),
                )
                return
            }

            finish()
        }

        ffmpeg.stderr?.on('data', (chunk) => {
            ffmpegStderr += chunk.toString()
        })
        pacat.stderr?.on('data', (chunk) => {
            pacatStderr += chunk.toString()
        })

        ffmpeg.on('error', (error) => {
            pacat.kill('SIGTERM')
            finish(error)
        })
        pacat.on('error', (error) => {
            ffmpeg.kill('SIGTERM')
            finish(error)
        })
        ffmpeg.on('close', (code) => {
            ffmpegExitCode = code
            pacat.stdin?.end()
            maybeFinish()
        })
        pacat.on('close', (code) => {
            pacatExitCode = code
            maybeFinish()
        })
    })
}

/**
 * Generate audio beep in the browser
 */
async function generateAudioBeep(
    page: any,
    frequency: number,
    duration: number,
    volume: number,
): Promise<void> {
    await page.evaluate(
        ({ freq, dur, vol }) => {
            if ((window as any).__syncAudioContext) {
                console.log(
                    '⚠️ AudioContext already exists, skipping duplicate beep',
                )
                return
            }

            try {
                const audioContext = new (window.AudioContext ||
                    (window as any).webkitAudioContext)()

                ;(window as any).__syncAudioContext = audioContext

                const oscillator = audioContext.createOscillator()
                const gainNode = audioContext.createGain()

                oscillator.connect(gainNode)
                gainNode.connect(audioContext.destination)

                oscillator.frequency.setValueAtTime(
                    freq,
                    audioContext.currentTime,
                )
                oscillator.type = 'sine'

                const durationSec = dur / 1000
                gainNode.gain.setValueAtTime(0, audioContext.currentTime)
                gainNode.gain.setValueAtTime(
                    vol,
                    audioContext.currentTime + 0.005,
                )
                gainNode.gain.setValueAtTime(
                    vol,
                    audioContext.currentTime + durationSec - 0.005,
                )
                gainNode.gain.setValueAtTime(
                    0,
                    audioContext.currentTime + durationSec,
                )

                oscillator.start(audioContext.currentTime)
                oscillator.stop(audioContext.currentTime + durationSec)

                setTimeout(() => {
                    try {
                        audioContext.close()
                        delete (window as any).__syncAudioContext
                    } catch (e) {
                        console.warn('AudioContext cleanup warning:', e)
                    }
                }, dur + 100)

                console.log(
                    `🔊 Audio beep: ${freq}Hz for ${dur}ms at volume ${vol}`,
                )
            } catch (error) {
                console.error('Audio beep error:', formatError(error))
                delete (window as any).__syncAudioContext
            }
        },
        { freq: frequency, dur: duration, vol: volume },
    )
}

/**
 * Generate visual flash overlay
 */
async function generateVisualFlash(
    page: any,
    color: string,
    duration: number,
): Promise<void> {
    await page.evaluate(
        ({ flashColor, dur }) => {
            if (document.querySelector('#sync-flash-overlay')) {
                console.log(
                    '⚠️ Flash overlay already exists, skipping duplicate',
                )
                return
            }

            const flashDiv = document.createElement('div')
            flashDiv.id = 'sync-flash-overlay'
            flashDiv.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: ${flashColor};
            z-index: 999999;
            pointer-events: none;
            box-shadow: inset 0 0 30px ${flashColor};
            opacity: 1;
        `

            document.body.appendChild(flashDiv)
            console.log(`💡 Visual flash: ${flashColor} for ${dur}ms`)

            setTimeout(() => {
                flashDiv.remove()
            }, dur)
        },
        { flashColor: color, dur: duration },
    )
}
