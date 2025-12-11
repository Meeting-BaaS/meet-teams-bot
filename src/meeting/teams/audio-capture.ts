// Web Audio mixing for Microsoft Teams
// Simple approach: Capture all audio tracks and mix them automatically

import { Page } from '@playwright/test'
import { Streaming } from '../../streaming'

/**
 * Enable Web Audio mixing for Teams
 * This provides clean mixed audio for streaming without complex network interception
 */
export async function enableTeamsAudioCapture(page: Page): Promise<void> {
    // Expose function for pre-mixed audio from Web Audio API
    await page.exposeFunction('onTeamsMixedAudioChunk', async (audioChunk: {
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
                console.error('[TeamsAudio] Failed to process mixed audio chunk:', error)
            }
        }
    })

    // Inject Web Audio mixing script
    const script = `
        (function() {
            try {
                console.log('[TeamsAudio] Initializing Web Audio mixer...')

                // Create AudioContext for mixing
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
                const mixerDestination = audioCtx.createMediaStreamDestination()
                const mixedAudioSources = new Map()
                let mixedStreamProcessor = null
                let chunksSent = 0

                // Start reading the pre-mixed stream
                async function startMixedStreamProcessor() {
                    if (mixedStreamProcessor) return // Already started

                    const mixedTrack = mixerDestination.stream.getAudioTracks()[0]
                    if (!mixedTrack) {
                        console.error('[TeamsAudio] ⚠️ No mixed audio track available')
                        return
                    }

                    try {
                        if (typeof MediaStreamTrackProcessor === 'undefined') {
                            console.error('[TeamsAudio] ⚠️ MediaStreamTrackProcessor not available')
                            return
                        }

                        const processor = new MediaStreamTrackProcessor({ track: mixedTrack })
                        const reader = processor.readable.getReader()
                        mixedStreamProcessor = reader

                        console.log('[TeamsAudio] 🎵 Started Web Audio mixed stream processor')

                        // Read pre-mixed frames continuously
                        const processFrames = async () => {
                            try {
                                while (true) {
                                    const { done, value: frame } = await reader.read()
                                    if (done) break
                                    if (!frame) continue

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
                                        if (typeof window.onTeamsMixedAudioChunk === 'function') {
                                            window.onTeamsMixedAudioChunk({
                                                audioData: Array.from(audioData),
                                                sampleRate: frame.sampleRate,
                                                timestamp: frame.timestamp,
                                                numberOfFrames: numSamples,
                                            })
                                            chunksSent++
                                            if (chunksSent === 1) {
                                                console.log('[TeamsAudio] ✅ First audio chunk sent to Node.js')
                                            } else if (chunksSent % 100 === 0) {
                                                console.log('[TeamsAudio] 📊 Sent ' + chunksSent + ' chunks to Node.js')
                                            }
                                        } else {
                                            if (chunksSent === 0) {
                                                console.error('[TeamsAudio] ⚠️ window.onTeamsMixedAudioChunk not available!')
                                            }
                                        }

                                        frame.close()
                                    } catch (err) {
                                        console.error('[TeamsAudio] Frame processing error:', err)
                                    }
                                }
                            } catch (err) {
                                console.error('[TeamsAudio] Mixed stream error:', err)
                            }
                        }

                        processFrames()
                    } catch (e) {
                        console.error('[TeamsAudio] Failed to start mixed stream processor:', e)
                    }
                }

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
                        window.__teamsMixedSourcesSize = mixedAudioSources.size

                        console.log(\`[TeamsAudio] 🎚️ Connected track \${track.id} to mixer (\${mixedAudioSources.size} total)\`)

                        // Start the processor when first track is connected
                        if (mixedAudioSources.size === 1) {
                            startMixedStreamProcessor()
                        }

                        track.onended = () => {
                            source.disconnect()
                            mixedAudioSources.delete(track.id)
                            window.__teamsMixedSourcesSize = mixedAudioSources.size
                            console.log(\`[TeamsAudio] 🔌 Disconnected track \${track.id} from mixer\`)
                        }
                    } catch (e) {
                        console.error('[TeamsAudio] Failed to connect track to mixer:', e)
                    }
                }

                // Monitor for audio tracks from RTCPeerConnection
                if (typeof RTCPeerConnection !== 'undefined') {
                    const OriginalPC = RTCPeerConnection
                    const allPeerConnections = []

                    // Expose for debugging
                    window.__teamsPeerConnections = allPeerConnections
                    window.__teamsMixedSourcesSize = 0

                    RTCPeerConnection = function(...args) {
                        const pc = new OriginalPC(...args)
                        allPeerConnections.push(pc)

                        pc.addEventListener('track', (event) => {
                            if (event.track.kind === 'audio') {
                                console.log('[TeamsAudio] 🎤 Audio track detected (new PC):', event.track.id)
                                connectTrackToMixer(event.track)
                            }
                        })

                        return pc
                    }

                    // Scan for existing tracks periodically
                    // Teams might create connections at different times
                    const scannedTracks = new Set()

                    function scanForTracks() {
                        console.log('[TeamsAudio] 🔍 Scanning for audio tracks...')
                        let foundTracks = 0
                        let newTracks = 0

                        allPeerConnections.forEach((pc, index) => {
                            try {
                                const receivers = pc.getReceivers()
                                receivers.forEach(receiver => {
                                    if (receiver.track && receiver.track.kind === 'audio') {
                                        foundTracks++
                                        if (!scannedTracks.has(receiver.track.id)) {
                                            console.log(\`[TeamsAudio] 🎤 Found audio track from PC[\${index}]:\`, receiver.track.id)
                                            connectTrackToMixer(receiver.track)
                                            scannedTracks.add(receiver.track.id)
                                            newTracks++
                                        }
                                    }
                                })
                            } catch (e) {
                                console.error(\`[TeamsAudio] Error scanning PC[\${index}]:\`, e)
                            }
                        })

                        console.log(\`[TeamsAudio] Scan complete: \${newTracks} new tracks, \${foundTracks} total tracks, \${allPeerConnections.length} peer connections\`)

                        if (foundTracks === 0 && allPeerConnections.length === 0) {
                            console.warn('[TeamsAudio] ⚠️ No peer connections or audio tracks found yet')
                        }
                    }

                    // Scan multiple times during meeting join
                    setTimeout(scanForTracks, 2000)  // After 2s
                    setTimeout(scanForTracks, 5000)  // After 5s
                    setTimeout(scanForTracks, 10000) // After 10s

                    // Keep scanning periodically
                    setInterval(scanForTracks, 30000) // Every 30s

                    console.log('[TeamsAudio] ✅ RTCPeerConnection intercepted')
                }

                console.log('[TeamsAudio] ✅ Web Audio mixer initialized')
            } catch (e) {
                console.error('[TeamsAudio] Initialization failed:', e)
            }
        })()
    `

    try {
        await page.addInitScript(script)
        console.log('[TeamsAudio] ✅ Web Audio capture script injected')
    } catch (error) {
        console.error('[TeamsAudio] Failed to inject audio capture script:', error)
    }
}

/**
 * Verify that Teams audio capture is working
 */
export async function verifyTeamsAudioCapture(page: Page): Promise<boolean> {
    try {
        const status = await page.evaluate(() => {
            return {
                hasAudioContext: typeof (window as any).AudioContext !== 'undefined',
                hasMediaStreamTrackProcessor: typeof (window as any).MediaStreamTrackProcessor !== 'undefined',
                hasCallback: typeof (window as any).onTeamsMixedAudioChunk !== 'undefined',
                hasRTCInterception: typeof (window as any).RTCPeerConnection !== 'undefined',
                peerConnectionCount: (window as any).__teamsPeerConnections?.length || 0,
                mixedSourcesCount: (window as any).__teamsMixedSourcesSize || 0,
            }
        })

        console.log('[TeamsAudio] Status:', status)

        if (!status.hasAudioContext) {
            console.error('[TeamsAudio] ❌ AudioContext not available')
            return false
        }

        if (!status.hasMediaStreamTrackProcessor) {
            console.error('[TeamsAudio] ❌ MediaStreamTrackProcessor not available')
            return false
        }

        if (!status.hasCallback) {
            console.warn('[TeamsAudio] ⚠️ Callback not registered yet')
        }

        if (status.peerConnectionCount === 0) {
            console.warn('[TeamsAudio] ⚠️ No peer connections detected yet')
        }

        if (status.mixedSourcesCount === 0) {
            console.warn('[TeamsAudio] ⚠️ No audio tracks connected to mixer yet')
        }

        return true
    } catch (e) {
        console.error('[TeamsAudio] ❌ Verification failed:', e)
        return false
    }
}
