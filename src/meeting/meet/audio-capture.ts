// Web Audio mixing for Google Meet
// Simple approach: Capture all audio tracks and mix them automatically

import { Page } from '@playwright/test'
import { Streaming } from '../../streaming'

/**
 * Enable Web Audio mixing for Google Meet
 * This provides clean mixed audio for streaming without complex network interception
 */
export async function enableMeetAudioCapture(page: Page): Promise<void> {
    // Expose function for pre-mixed audio from Web Audio API
    await page.exposeFunction('onMeetMixedAudioChunk', async (audioChunk: {
        audioData: number[]
        sampleRate: number
        timestamp: number
        numberOfFrames: number
    }) => {
        // Forward pre-mixed audio directly to streaming
        if (Streaming.instance) {
            try {
                Streaming.instance.processMixedAudioChunk(audioChunk)
            } catch (error) {
                console.error('[MeetAudio] Failed to process mixed audio chunk:', error)
            }
        }
    })

    // Inject Web Audio mixing script
    const script = `
        (function() {
            try {
                console.log('[MeetAudio] Initializing Web Audio mixer...')

                // Create AudioContext for mixing
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
                const mixerDestination = audioCtx.createMediaStreamDestination()
                const mixedAudioSources = new Map()
                let mixedStreamProcessor = null
                let chunksSent = 0

                // Abort controller for cleanup
                let abortController = null
                let processorPromise = null

                // Start reading the pre-mixed stream
                async function startMixedStreamProcessor() {
                    if (mixedStreamProcessor) return // Already started

                    const mixedTrack = mixerDestination.stream.getAudioTracks()[0]
                    if (!mixedTrack) {
                        console.error('[MeetAudio] ⚠️ No mixed audio track available')
                        return
                    }

                    try {
                        if (typeof MediaStreamTrackProcessor === 'undefined') {
                            console.error('[MeetAudio] ⚠️ MediaStreamTrackProcessor not available')
                            return
                        }

                        const processor = new MediaStreamTrackProcessor({ track: mixedTrack })
                        const reader = processor.readable.getReader()
                        mixedStreamProcessor = reader

                        // Create abort controller for cancellation
                        abortController = new AbortController()
                        const signal = abortController.signal

                        console.log('[MeetAudio] 🎵 Started Web Audio mixed stream processor')

                        // Read pre-mixed frames continuously with cancellation support
                        const processFrames = async (signal) => {
                            let currentFrame = null

                            // Handle abort signal
                            const onAbort = () => {
                                console.log('[MeetAudio] 🛑 Abort signal received, cancelling reader...')
                                reader.cancel().catch(err => {
                                    console.log('[MeetAudio] Reader cancel error (expected):', err.message || err)
                                })
                            }
                            signal.addEventListener('abort', onAbort)

                            try {
                                while (true) {
                                    // Check for abort before reading
                                    if (signal.aborted) {
                                        console.log('[MeetAudio] 🛑 Processing aborted (pre-read check)')
                                        break
                                    }

                                    const { done, value: frame } = await reader.read()
                                    if (done) {
                                        console.log('[MeetAudio] 📭 Reader done, stream ended')
                                        break
                                    }

                                    // Check for abort after reading
                                    if (signal.aborted) {
                                        console.log('[MeetAudio] 🛑 Processing aborted (post-read check)')
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
                                        if (typeof window.onMeetMixedAudioChunk === 'function') {
                                            window.onMeetMixedAudioChunk({
                                                audioData: Array.from(audioData),
                                                sampleRate: frame.sampleRate,
                                                timestamp: frame.timestamp,
                                                numberOfFrames: numSamples,
                                            })
                                            chunksSent++
                                            if (chunksSent === 1) {
                                                console.log('[MeetAudio] ✅ First audio chunk sent to Node.js')
                                            } else if (chunksSent % 100 === 0) {
                                                console.log('[MeetAudio] 📊 Sent ' + chunksSent + ' chunks to Node.js')
                                            }
                                        } else {
                                            if (chunksSent === 0) {
                                                console.error('[MeetAudio] ⚠️ window.onMeetMixedAudioChunk not available!')
                                            }
                                        }

                                        frame.close()
                                        currentFrame = null
                                    } catch (err) {
                                        console.error('[MeetAudio] Frame processing error:', err)
                                        if (currentFrame) {
                                            currentFrame.close()
                                            currentFrame = null
                                        }
                                    }
                                }
                            } catch (err) {
                                if (signal.aborted) {
                                    console.log('[MeetAudio] 🛑 Stream read cancelled (abort)')
                                } else {
                                    console.error('[MeetAudio] Mixed stream error:', err)
                                }
                            } finally {
                                // Cleanup
                                signal.removeEventListener('abort', onAbort)
                                if (currentFrame) {
                                    try { currentFrame.close() } catch (e) {}
                                }
                                try {
                                    reader.releaseLock()
                                    console.log('[MeetAudio] 🔓 Reader lock released')
                                } catch (e) {
                                    console.log('[MeetAudio] Reader lock release error:', e.message || e)
                                }
                                mixedStreamProcessor = null
                                console.log('[MeetAudio] 🧹 Processor cleanup complete, sent ' + chunksSent + ' total chunks')
                            }
                        }

                        // Start processing and store promise for await on cleanup
                        processorPromise = processFrames(signal)
                    } catch (e) {
                        console.error('[MeetAudio] Failed to start mixed stream processor:', e)
                    }
                }

                // Stop the processor gracefully
                async function stopMixedStreamProcessor() {
                    if (abortController) {
                        console.log('[MeetAudio] 🛑 Stopping mixed stream processor...')
                        abortController.abort()
                        if (processorPromise) {
                            await processorPromise
                        }
                        abortController = null
                        processorPromise = null
                        console.log('[MeetAudio] ✅ Mixed stream processor stopped')
                    }
                }

                // Expose stop function globally for cleanup on page unload/navigation
                window.__meetAudioStop = stopMixedStreamProcessor

                // Auto-cleanup on page unload
                window.addEventListener('beforeunload', () => {
                    stopMixedStreamProcessor()
                })

                // Auto-cleanup on visibility change (page hidden/navigated)
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'hidden') {
                        console.log('[MeetAudio] Page hidden, stopping processor...')
                        stopMixedStreamProcessor()
                    }
                })

                // Connect a track to the mixer
                function connectTrackToMixer(track) {
                    if (mixedAudioSources.has(track.id)) return // Already connected

                    try {
                        if (audioCtx.state === 'suspended') audioCtx.resume()

                        const stream = new MediaStream([track])
                        const source = audioCtx.createMediaStreamSource(stream)

                        // Connect to mixer destination (browser does the mixing!)
                        source.connect(mixerDestination)
                        mixedAudioSources.set(track.id, source)

                        console.log('[MeetAudio] 🎚️ Connected track ' + track.id + ' to mixer (' + mixedAudioSources.size + ' total)')

                        // Start the processor when first track is connected
                        if (mixedAudioSources.size === 1) {
                            startMixedStreamProcessor()
                        }

                        track.onended = () => {
                            source.disconnect()
                            mixedAudioSources.delete(track.id)
                            console.log('[MeetAudio] 🔌 Disconnected track ' + track.id + ' from mixer')
                        }
                    } catch (e) {
                        console.error('[MeetAudio] Failed to connect track to mixer:', e)
                    }
                }

                // Intercept RTCPeerConnection to capture audio tracks
                if (typeof window.RTCPeerConnection !== 'undefined') {
                    const OriginalPC = window.RTCPeerConnection
                    window.RTCPeerConnection = function (...args) {
                        const pc = new OriginalPC(...args)
                        pc.addEventListener('track', (event) => {
                            if (event.track.kind === 'audio') {
                                console.log('[MeetAudio] 🎤 Audio track detected:', event.track.id)
                                connectTrackToMixer(event.track)
                            }
                        })
                        return pc
                    }
                    console.log('[MeetAudio] ✅ RTCPeerConnection intercepted')
                }
            } catch (e) {
                console.error('[MeetAudio] Fatal Error:', e)
            }
        })();
    `

    try {
        await page.addInitScript(script)
        console.log('[MeetAudio] ✅ Web Audio mixer script injected')
    } catch (error) {
        console.error('[MeetAudio] Failed to inject mixer script:', error)
    }
}

/**
 * Stop the audio capture processor gracefully
 */
export async function stopMeetAudioCapture(page: Page): Promise<void> {
    try {
        await page.evaluate(() => {
            if (typeof (window as any).__meetAudioStop === 'function') {
                return (window as any).__meetAudioStop()
            }
        })
        console.log('[MeetAudio] ✅ Audio capture stopped from Node.js')
    } catch (error) {
        console.error('[MeetAudio] Failed to stop audio capture:', error)
    }
}

/**
 * Verify that audio capture is working
 */
export async function verifyMeetAudioCapture(page: Page): Promise<boolean> {
    try {
        const status = await page.evaluate(() => {
            return {
                hasAudioContext: typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined',
                hasMediaStreamTrackProcessor: typeof (window as any).MediaStreamTrackProcessor !== 'undefined',
                hasCallback: typeof (window as any).onMeetMixedAudioChunk === 'function',
            }
        })

        console.log('[MeetAudio] Status:', status)

        if (!status.hasAudioContext) {
            console.error('[MeetAudio] ❌ AudioContext not available')
            return false
        }

        if (!status.hasMediaStreamTrackProcessor) {
            console.error('[MeetAudio] ❌ MediaStreamTrackProcessor not available')
            return false
        }

        if (!status.hasCallback) {
            console.error('[MeetAudio] ❌ Callback not registered')
            return false
        }

        console.log('[MeetAudio] ✅ Audio capture verified')
        return true
    } catch (error) {
        console.error('[MeetAudio] ❌ Verification failed:', error)
        return false
    }
}
