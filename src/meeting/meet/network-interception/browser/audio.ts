// Browser-side audio processing and monitoring

import type { ReceiverManager, UserManager } from '../types'
import {
    getAllUsers,
    getContributingSources,
    getUserByStreamId,
    linkReceiverToTrack,
} from './managers'
import { decodeUserName } from './utils'

// --- Audio Frame Processor ---

export async function processAudioFrames(
    track: any,
    receiver: any,
    receiverManager: ReceiverManager,
    userManager: UserManager,
): Promise<boolean> {
    let reader: any = null

    try {
        // Check if MediaStreamTrackProcessor is available
        if (
            typeof (window as any).MediaStreamTrackProcessor === 'undefined' ||
            typeof (window as any).MediaStreamTrackGenerator === 'undefined'
        ) {
            console.error(
                '[NetworkInterceptor] ⚠️ MediaStreamTrackProcessor/Generator not available, using fallback',
            )
            return false
        }

        const processor = new (window as any).MediaStreamTrackProcessor({
            track,
        })
        reader = processor.readable.getReader()

        console.error(
            `[NetworkInterceptor] 🎬 Audio Frame Processing Started: ${track.id}`,
        )

        // Process frames in a loop
        ;(async () => {
            try {
                while (true) {
                    const { done, value: frame } = await reader.read()
                    if (done) break
                    if (!frame) continue

                    try {
                        // Extract audio data from frame
                        const numChannels = frame.numberOfChannels
                        const numSamples = frame.numberOfFrames
                        const audioData = new Float32Array(numSamples)

                        // Convert to mono if needed
                        if (numChannels > 1) {
                            const channelData = new Float32Array(numSamples)
                            for (
                                let channel = 0;
                                channel < numChannels;
                                channel++
                            ) {
                                frame.copyTo(channelData, {
                                    planeIndex: channel,
                                })
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

                        // Check if audio has content (not silence)
                        const hasAudio = audioData.some(
                            (v) => Math.abs(v) > 0.001,
                        )

                        if (hasAudio) {
                            // Get attribution from contributing sources
                            const contributingSources = getContributingSources(
                                receiverManager,
                                receiver,
                            )

                            if (
                                contributingSources &&
                                contributingSources.length > 0
                            ) {
                                // Map SSRCs to users with audio levels
                                const usersWithAudioLevels = contributingSources
                                    .map((source) => ({
                                        audioLevel: source?.audioLevel || 0,
                                        ssrc: source.source,
                                        timestamp: source.timestamp,
                                        user: getUserByStreamId(
                                            userManager,
                                            source.source.toString(),
                                        ),
                                    }))
                                    .filter(
                                        (x) => x.user && x.audioLevel > 0.05,
                                    )
                                    .sort((a, b) => b.audioLevel - a.audioLevel)

                                // Get the loudest speaker
                                const loudestSpeaker = usersWithAudioLevels[0]

                                if (loudestSpeaker?.user) {
                                    const userName = decodeUserName(
                                        loudestSpeaker.user,
                                    )

                                    console.error(
                                        '[NetworkInterceptor] 🗣️ Audio Attributed:',
                                        {
                                            userName,
                                            deviceId:
                                                loudestSpeaker.user.deviceId,
                                            audioLevel:
                                                loudestSpeaker.audioLevel.toFixed(
                                                    3,
                                                ),
                                            ssrc: loudestSpeaker.ssrc,
                                            trackId: track.id.substring(0, 8),
                                            samples: numSamples,
                                        },
                                    )

                                    // Broadcast speaker info to Node.js
                                    if (
                                        typeof (window as any)
                                            .onNetworkSpeakerUpdate ===
                                        'function'
                                    ) {
                                        // Get all users and mark the speaking one
                                        const allUsers =
                                            getAllUsers(userManager)
                                        const users = allUsers.map(
                                            (user: any) => {
                                                const decodedName =
                                                    decodeUserName(user)
                                                return {
                                                    deviceId: user.deviceId,
                                                    name: decodedName,
                                                    isCurrentUser:
                                                        user.isCurrentUserString ===
                                                            'true' ||
                                                        user.isCurrentUserString ===
                                                            '1',
                                                    isSpeaking:
                                                        user.deviceId ===
                                                        loudestSpeaker.user
                                                            .deviceId,
                                                    status: user.status,
                                                    isHost: user.isHost === 1,
                                                    audioLevel:
                                                        user.deviceId ===
                                                        loudestSpeaker.user
                                                            .deviceId
                                                            ? loudestSpeaker.audioLevel
                                                            : 0,
                                                }
                                            },
                                        )

                                        ;(window as any).onNetworkSpeakerUpdate(
                                            {
                                                users,
                                                timestamp: Date.now(),
                                                source: 'audio',
                                            },
                                        )
                                    }
                                }
                            }
                        }

                        // Close the frame
                        frame.close()
                    } catch (frameError) {
                        console.error(
                            '[NetworkInterceptor] Frame Processing Error:',
                            frameError,
                        )
                        if (frame) frame.close()
                    }
                }
            } catch (readError) {
                console.error('[NetworkInterceptor] Reader Error:', readError)
            } finally {
                if (reader) {
                    try {
                        await reader.cancel()
                        reader.releaseLock()
                    } catch {}
                }
            }
        })()

        return true
    } catch (e) {
        console.error(
            '[NetworkInterceptor] Audio Frame Processing Setup Error:',
            e,
        )
        return false
    }
}

// --- Web Audio API Monitoring ---

export function setupWebAudioMonitoring(
    track: any,
    receiver: any,
    audioCtx: AudioContext,
    activeAudioTracks: Map<string, any>,
): void {
    try {
        if (audioCtx.state === 'suspended') audioCtx.resume()

        const stream = new MediaStream([track])
        const source = audioCtx.createMediaStreamSource(stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        const gain = audioCtx.createGain()
        gain.gain.value = 0.001 // Mute but keep processing

        source.connect(analyser)
        analyser.connect(gain)
        gain.connect(audioCtx.destination)

        activeAudioTracks.set(track.id, { analyser, receiver })
        console.error(
            `[NetworkInterceptor] 🎤 Web Audio Monitoring: ${track.id}`,
        )

        track.onended = () => {
            activeAudioTracks.delete(track.id)
        }
    } catch (e) {
        console.error('[NetworkInterceptor] Web Audio Setup Error:', e)
    }
}

// --- Track Monitoring Orchestrator ---

export function monitorTrack(
    track: MediaStreamTrack,
    receiver: RTCRtpReceiver,
    receiverManager: ReceiverManager,
    userManager: UserManager,
    audioCtx: AudioContext,
    activeAudioTracks: Map<string, any>,
): void {
    if (activeAudioTracks.has(track.id)) return

    try {
        // Link receiver to track in manager
        linkReceiverToTrack(receiverManager, receiver, track.id)

        // Try to use audio frame processing first (preferred method)
        processAudioFrames(track, receiver, receiverManager, userManager).then(
            (success) => {
                if (!success) {
                    // Fallback to Web Audio API monitoring
                    setupWebAudioMonitoring(
                        track,
                        receiver,
                        audioCtx,
                        activeAudioTracks,
                    )
                }
            },
        )

        // Also set up Web Audio API as backup for volume monitoring
        setupWebAudioMonitoring(track, receiver, audioCtx, activeAudioTracks)
    } catch (e) {
        console.error('[NetworkInterceptor] Audio Attach Error:', e)
    }
}
