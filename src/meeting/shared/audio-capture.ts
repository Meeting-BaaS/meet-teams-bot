// Centralized audio track connection layer for Meet and Teams
// This is the SINGLE point where RTCPeerConnection is intercepted
// Other systems (network-interception, etc.) subscribe to track events via hooks

import { Page } from '@playwright/test'
import { Streaming } from '../../streaming'
import { formatError } from '../../utils/Logger'

export interface AudioCaptureConfig {
    provider: 'Meet' | 'Teams'
    callbackName: string
    logPrefix: string
    stopFunctionName: string
    // Teams needs periodic scanning, Meet doesn't
    enablePeriodicScanning?: boolean
    // Optional: Enable audio mixing for streaming
    enableMixing?: boolean
}

const MEET_CONFIG: AudioCaptureConfig = {
    provider: 'Meet',
    callbackName: 'onMeetMixedAudioChunk',
    logPrefix: '[AudioCapture-Meet]',
    stopFunctionName: '__meetAudioStop',
    enablePeriodicScanning: false,
    enableMixing: false, // Will be set dynamically based on streaming config
}

const TEAMS_CONFIG: AudioCaptureConfig = {
    provider: 'Teams',
    callbackName: 'onTeamsMixedAudioChunk',
    logPrefix: '[AudioCapture-Teams]',
    stopFunctionName: '__teamsAudioStop',
    enablePeriodicScanning: true,
    enableMixing: true, // Teams always needs mixing
}

/**
 * Generate the browser-side audio capture script
 * This is the CENTRALIZED track connection layer
 */
function generateAudioCaptureScript(config: AudioCaptureConfig): string {
    const { callbackName, logPrefix, stopFunctionName, enablePeriodicScanning, enableMixing } = config

    return `
        (function() {
            try {
                console.log('${logPrefix} Initializing centralized audio track layer...')

                // Create AudioContext
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)()

                // Track event subscribers (other systems can register here)
                const trackSubscribers = []

                ${enableMixing ? `
                // Audio mixer (only if streaming enabled)
                const mixerDestination = audioCtx.createMediaStreamDestination()
                const mixedAudioSources = new Map()
                let mixedStreamProcessor = null
                let chunksSent = 0` : '// Audio mixer disabled (no streaming)'}

                // Abort controller for cleanup
                let abortController = null
                let processorPromise = null

                // Placeholder for periodic scanning cleanup (set when enablePeriodicScanning is true)
                let stopPeriodicScanningFn = null

                // Start reading the pre-mixed stream
                async function startMixedStreamProcessor() {
                    if (mixedStreamProcessor) return // Already started

                    const mixedTrack = mixerDestination.stream.getAudioTracks()[0]
                    if (!mixedTrack) {
                        console.error('${logPrefix} No mixed audio track available')
                        return
                    }

                    try {
                        if (typeof MediaStreamTrackProcessor === 'undefined') {
                            console.error('${logPrefix} MediaStreamTrackProcessor not available')
                            return
                        }

                        const processor = new MediaStreamTrackProcessor({ track: mixedTrack })
                        const reader = processor.readable.getReader()
                        mixedStreamProcessor = reader

                        // Create abort controller for cancellation
                        abortController = new AbortController()
                        const signal = abortController.signal

                        console.log('${logPrefix} Started Web Audio mixed stream processor')

                        // Read pre-mixed frames continuously with cancellation support
                        const processFrames = async (signal) => {
                            let currentFrame = null

                            // Handle abort signal
                            const onAbort = () => {
                                console.log('${logPrefix} Abort signal received, cancelling reader...')
                                reader.cancel().catch(err => {
                                    console.log('${logPrefix} Reader cancel error (expected):', err.message || err)
                                })
                            }
                            signal.addEventListener('abort', onAbort)

                            try {
                                while (true) {
                                    // Check for abort before reading
                                    if (signal.aborted) {
                                        console.log('${logPrefix} Processing aborted (pre-read check)')
                                        break
                                    }

                                    const { done, value: frame } = await reader.read()
                                    if (done) {
                                        console.log('${logPrefix} Reader done, stream ended')
                                        break
                                    }

                                    // Check for abort after reading
                                    if (signal.aborted) {
                                        console.log('${logPrefix} Processing aborted (post-read check)')
                                        if (frame) frame.close()
                                        break
                                    }

                                    if (!frame) continue
                                    currentFrame = frame

                                    try {
                                        const numChannels = frame.numberOfChannels
                                        const numSamples = frame.numberOfFrames
                                        const audioData = new Float32Array(numSamples)

                                        // Mix channels if stereo
                                        if (numChannels > 1) {
                                            const channelData = new Float32Array(numSamples)
                                            for (let channel = 0; channel < numChannels; channel++) {
                                                frame.copyTo(channelData, { planeIndex: channel })
                                                for (let i = 0; i < numSamples; i++) {
                                                    audioData[i] += channelData[i]
                                                }
                                            }
                                            for (let i = 0; i < numSamples; i++) {
                                                audioData[i] /= numChannels
                                            }
                                        } else {
                                            frame.copyTo(audioData, { planeIndex: 0 })
                                        }

                                        // Send pre-mixed audio to Node.js
                                        if (typeof window.${callbackName} === 'function') {
                                            window.${callbackName}({
                                                audioData: Array.from(audioData),
                                                sampleRate: frame.sampleRate,
                                                timestamp: frame.timestamp,
                                                numberOfFrames: numSamples,
                                            })
                                            chunksSent++
                                            if (chunksSent === 1) {
                                                console.log('${logPrefix} First audio chunk sent to Node.js')
                                            } else if (chunksSent % 100 === 0) {
                                                console.log('${logPrefix} Sent ' + chunksSent + ' chunks to Node.js')
                                            }
                                        } else {
                                            if (chunksSent === 0) {
                                                console.error('${logPrefix} window.${callbackName} not available!')
                                            }
                                        }

                                        frame.close()
                                        currentFrame = null
                                    } catch (err) {
                                        console.error('${logPrefix} Frame processing error:', err)
                                        if (currentFrame) {
                                            currentFrame.close()
                                            currentFrame = null
                                        }
                                    }
                                }
                            } catch (err) {
                                if (signal.aborted) {
                                    console.log('${logPrefix} Stream read cancelled (abort)')
                                } else {
                                    console.error('${logPrefix} Mixed stream error:', err)
                                }
                            } finally {
                                // Cleanup
                                signal.removeEventListener('abort', onAbort)
                                if (currentFrame) {
                                    try { currentFrame.close() } catch (e) {}
                                }
                                try {
                                    reader.releaseLock()
                                    console.log('${logPrefix} Reader lock released')
                                } catch (e) {
                                    console.log('${logPrefix} Reader lock release error:', e.message || e)
                                }
                                mixedStreamProcessor = null
                                console.log('${logPrefix} Processor cleanup complete, sent ' + chunksSent + ' total chunks')
                            }
                        }

                        // Start processing and store promise for await on cleanup
                        processorPromise = processFrames(signal)
                    } catch (e) {
                        console.error('${logPrefix} Failed to start mixed stream processor:', e)
                    }
                }

                // Stop the processor gracefully
                async function stopMixedStreamProcessor() {
                    // Stop periodic scanning first (if enabled)
                    if (stopPeriodicScanningFn) {
                        stopPeriodicScanningFn()
                    }

                    if (abortController) {
                        console.log('${logPrefix} Stopping mixed stream processor...')
                        abortController.abort()
                        if (processorPromise) {
                            await processorPromise
                        }
                        abortController = null
                        processorPromise = null
                        console.log('${logPrefix} Mixed stream processor stopped')
                    }
                }

                // Expose stop function globally for cleanup
                window.${stopFunctionName} = stopMixedStreamProcessor

                // Auto-cleanup on page unload
                window.addEventListener('beforeunload', () => {
                    stopMixedStreamProcessor()
                })

                // Auto-cleanup on visibility change
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'hidden') {
                        console.log('${logPrefix} Page hidden, stopping processor...')
                        stopMixedStreamProcessor()
                    }
                })

                ${enableMixing ? `
                // Connect a track to the mixer (only if mixing enabled)
                function connectTrackToMixer(track) {
                    if (mixedAudioSources.has(track.id)) return // Already connected

                    try {
                        if (audioCtx.state === 'suspended') audioCtx.resume()

                        const stream = new MediaStream([track])
                        const source = audioCtx.createMediaStreamSource(stream)

                        // Connect to mixer destination (browser does the mixing!)
                        source.connect(mixerDestination)
                        mixedAudioSources.set(track.id, source)

                        console.log('${logPrefix} Connected track ' + track.id + ' to mixer (' + mixedAudioSources.size + ' total)')

                        // Start the processor when first track is connected
                        if (mixedAudioSources.size === 1) {
                            startMixedStreamProcessor()
                        }

                        track.onended = () => {
                            source.disconnect()
                            mixedAudioSources.delete(track.id)
                            console.log('${logPrefix} Disconnected track ' + track.id + ' from mixer')
                        }
                    } catch (e) {
                        console.error('${logPrefix} Failed to connect track to mixer:', e)
                    }
                }` : ''}

                // CENTRALIZED track notification - notify all subscribers
                function notifyTrackConnected(track, receiver, pc) {
                    console.log('${logPrefix} 🎵 Audio track detected:', track.id)

                    // Notify all registered subscribers (e.g., network-interception)
                    trackSubscribers.forEach(subscriber => {
                        try {
                            subscriber.onTrack(track, receiver, pc)
                        } catch (e) {
                            console.error('${logPrefix} Track subscriber error:', e)
                        }
                    })

                    ${enableMixing ? `
                    // Connect to mixer if enabled
                    connectTrackToMixer(track)` : ''}
                }

                // Expose subscription API for other systems
                window.__audioTrackLayer = {
                    subscribe: (callbacks) => {
                        trackSubscribers.push(callbacks)
                        console.log('${logPrefix} ✅ Track subscriber registered')
                    },
                    audioCtx: audioCtx
                }

                // Intercept RTCPeerConnection to capture audio tracks (SINGLE POINT)
                if (typeof window.RTCPeerConnection !== 'undefined') {
                    const OriginalPC = window.RTCPeerConnection
                    ${enablePeriodicScanning ? 'const allPeerConnections = []' : ''}

                    window.RTCPeerConnection = function (...args) {
                        const pc = new OriginalPC(...args)
                        ${enablePeriodicScanning ? 'allPeerConnections.push(pc)' : ''}

                        pc.addEventListener('track', (event) => {
                            if (event.track.kind === 'audio') {
                                // CENTRALIZED: Notify all systems about this track
                                notifyTrackConnected(event.track, event.receiver, pc)
                            }
                        })
                        return pc
                    }

                    ${enablePeriodicScanning ? `
                    // Teams needs periodic scanning as connections may be created at different times
                    const scannedTracks = new Set()

                    // Store timer IDs for cleanup to prevent memory leaks
                    let periodicScanIntervalId = null
                    const scanTimeoutIds = []

                    function scanForTracks() {
                        let foundTracks = 0
                        let newTracks = 0

                        allPeerConnections.forEach((pc, index) => {
                            try {
                                const receivers = pc.getReceivers()
                                receivers.forEach(receiver => {
                                    if (receiver.track && receiver.track.kind === 'audio') {
                                        foundTracks++
                                        if (!scannedTracks.has(receiver.track.id)) {
                                            // CENTRALIZED: Notify all systems
                                            notifyTrackConnected(receiver.track, receiver, pc)
                                            scannedTracks.add(receiver.track.id)
                                            newTracks++
                                        }
                                    }
                                })
                            } catch (e) {
                                console.error('${logPrefix} Error scanning PC[' + index + ']:', e)
                            }
                        })

                        if (newTracks > 0) {
                            console.log('${logPrefix} Scan: ' + newTracks + ' new tracks, ' + foundTracks + ' total')
                        }
                    }

                    // Stop periodic scanning and clear all timers
                    function stopPeriodicScanning() {
                        if (periodicScanIntervalId !== null) {
                            clearInterval(periodicScanIntervalId)
                            periodicScanIntervalId = null
                        }
                        scanTimeoutIds.forEach(id => clearTimeout(id))
                        scanTimeoutIds.length = 0
                        console.log('${logPrefix} Periodic scanning stopped')
                    }

                    // Register cleanup function for stopMixedStreamProcessor to call
                    stopPeriodicScanningFn = stopPeriodicScanning

                    // Scan multiple times during meeting join
                    scanTimeoutIds.push(setTimeout(scanForTracks, 2000))
                    scanTimeoutIds.push(setTimeout(scanForTracks, 5000))
                    scanTimeoutIds.push(setTimeout(scanForTracks, 10000))
                    periodicScanIntervalId = setInterval(scanForTracks, 30000)
                    ` : ''}

                    console.log('${logPrefix} RTCPeerConnection intercepted')
                }

                console.log('${logPrefix} Web Audio mixer initialized')
            } catch (e) {
                console.error('${logPrefix} Fatal Error:', e)
            }
        })();
    `
}

/**
 * Create audio capture functions for a specific provider
 */
export function createAudioCapture(config: AudioCaptureConfig) {
    const { callbackName, logPrefix, stopFunctionName } = config

    return {
        /**
         * Enable audio capture for this provider
         * @param enableMixing - Optional: override config to enable/disable mixing
         */
        enable: async (page: Page, enableMixing?: boolean): Promise<void> => {
            // Override mixing config if specified
            const finalConfig = enableMixing !== undefined
                ? { ...config, enableMixing }
                : config
            // Expose callback function for audio chunks
            // Guard against duplicate registration (may be called multiple times)
            try {
                await page.exposeFunction(callbackName, async (audioChunk: {
                    audioData: number[]
                    sampleRate: number
                    timestamp: number
                    numberOfFrames: number
                }) => {
                    if (Streaming.instance) {
                        try {
                            Streaming.instance.processMixedAudioChunk(audioChunk)
                        } catch (error) {
                            console.error(`${logPrefix} Failed to process mixed audio chunk:`, formatError(error))
                        }
                    }
                })
            } catch (error) {
                // Ignore duplicate registration error (function already exposed)
                const errorMessage = error instanceof Error ? error.message : String(error)
                if (errorMessage.includes('has been already registered')) {
                    console.log(`${logPrefix} Callback ${callbackName} already registered, skipping`)
                } else {
                    throw error
                }
            }

            // Inject the audio capture script
            const script = generateAudioCaptureScript(finalConfig)
            try {
                await page.addInitScript(script)
                console.log(`${logPrefix} Centralized audio track layer injected (mixing: ${finalConfig.enableMixing})`)
            } catch (error) {
                console.error(`${logPrefix} Failed to inject audio track layer:`, formatError(error))
            }
        },

        /**
         * Stop audio capture gracefully
         */
        stop: async (page: Page): Promise<void> => {
            try {
                await page.evaluate((stopFn) => {
                    if (typeof (window as any)[stopFn] === 'function') {
                        return (window as any)[stopFn]()
                    }
                }, stopFunctionName)
                console.log(`${logPrefix} Audio capture stopped from Node.js`)
            } catch (error) {
                console.error(`${logPrefix} Failed to stop audio capture:`, formatError(error))
            }
        },

        /**
         * Verify audio capture is working
         */
        verify: async (page: Page): Promise<boolean> => {
            try {
                const status = await page.evaluate((cbName) => {
                    return {
                        hasAudioContext: typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined',
                        hasMediaStreamTrackProcessor: typeof (window as any).MediaStreamTrackProcessor !== 'undefined',
                        hasCallback: typeof (window as any)[cbName] === 'function',
                    }
                }, callbackName)

                console.log(`${logPrefix} Status:`, status)

                if (!status.hasAudioContext) {
                    console.error(`${logPrefix} AudioContext not available`)
                    return false
                }

                if (!status.hasMediaStreamTrackProcessor) {
                    console.error(`${logPrefix} MediaStreamTrackProcessor not available`)
                    return false
                }

                if (!status.hasCallback) {
                    console.error(`${logPrefix} Callback not registered`)
                    return false
                }

                console.log(`${logPrefix} Audio capture verified`)
                return true
            } catch (error) {
                console.error(`${logPrefix} Verification failed:`, formatError(error))
                return false
            }
        },
    }
}

// Pre-configured instances for Meet and Teams
export const meetAudioCapture = createAudioCapture(MEET_CONFIG)
export const teamsAudioCapture = createAudioCapture(TEAMS_CONFIG)
