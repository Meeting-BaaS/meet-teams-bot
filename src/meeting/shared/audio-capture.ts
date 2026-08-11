// Shared audio track layer for Meet and Teams
// Intercepts RTCPeerConnection to expose audio tracks for network diarization
// Audio streaming is handled separately by FFmpeg PulseAudio capture

import type { Page } from "@playwright/test"
import { formatError } from "../../utils/Logger"

// Extend Window interface for browser APIs and audio capture functions
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
    __meetAudioStop?: () => Promise<void>
    __teamsAudioStop?: () => Promise<void>
    [key: string]: unknown // Allow dynamic property access for stop function names
  }
}

export interface AudioCaptureConfig {
  provider: "Meet" | "Teams"
  logPrefix: string
  stopFunctionName: string
  // Teams needs periodic scanning, Meet doesn't
  enablePeriodicScanning?: boolean
}

const MEET_CONFIG: AudioCaptureConfig = {
  provider: "Meet",
  logPrefix: "[MeetAudio]",
  stopFunctionName: "__meetAudioStop",
  enablePeriodicScanning: false
}

const TEAMS_CONFIG: AudioCaptureConfig = {
  provider: "Teams",
  logPrefix: "[TeamsAudio]",
  stopFunctionName: "__teamsAudioStop",
  enablePeriodicScanning: true
}

/**
 * Generate the browser-side audio track layer script.
 * Creates __audioTrackLayer and intercepts RTCPeerConnection to detect audio tracks.
 * Track subscribers (e.g. network diarization) are notified via __audioTrackLayer.subscribe().
 */
export function generateAudioCaptureScript(config: AudioCaptureConfig): string {
  const { logPrefix, stopFunctionName, enablePeriodicScanning } = config

  return `
        (function() {
            try {
                // Idempotent initialization: Reuse existing window.__audioTrackLayer if present
                if (!window.__audioTrackLayer) {
                    console.log("${logPrefix} Initializing centralized audio track layer...")

                const audioCtx = new (window.AudioContext || window.webkitAudioContext)()

                    window.__audioTrackLayer = {
                        subscribers: [],
                        // Tracks seen before anyone subscribed. This layer is installed
                        // before navigation, while the diarization interceptor only
                        // subscribes once the bot is admitted — so every track the call
                        // set up in between used to be delivered to nobody and was never
                        // mentioned again. A subscriber that arrives late gets them now.
                        seenTracks: [],
                        subscribe: (callbacks) => {
                            window.__audioTrackLayer.subscribers.push(callbacks)
                            console.log("${logPrefix} Track subscriber registered")
                            const backlog = window.__audioTrackLayer.seenTracks || []
                            if (backlog.length && callbacks && typeof callbacks.onTrack === "function") {
                                console.log("${logPrefix} Replaying " + backlog.length + " already-detected track(s) to new subscriber")
                                backlog.forEach(entry => {
                                    if (entry.track.readyState === "ended") return
                                    try {
                                        callbacks.onTrack(entry.track, entry.receiver, entry.pc)
                                    } catch (e) {
                                        console.error("${logPrefix} Error replaying track to subscriber:", e)
                                    }
                                })
                            }
                        },
                        audioCtx: audioCtx
                    }
                } else if (window.__audioTrackLayer && !window.__audioTrackLayer.subscribers) {
                    window.__audioTrackLayer.subscribers = []
                    console.log("${logPrefix} Upgraded existing audio track layer with subscribers array")
                } else {
                    console.log("${logPrefix} Audio track layer already initialized, reusing existing instance")
                }

                const trackSubscribers = window.__audioTrackLayer.subscribers

                // Placeholder for periodic scanning cleanup (set when enablePeriodicScanning is true)
                let stopPeriodicScanningFn = null

                // Cleanup function
                async function stopAudioCapture() {
                    if (stopPeriodicScanningFn) {
                        stopPeriodicScanningFn()
                    }
                    // Nobody will subscribe again, so drop the backlog rather than
                    // keep tracks, receivers and peer connections reachable.
                    if (window.__audioTrackLayer) {
                        window.__audioTrackLayer.seenTracks = []
                    }
                    console.log("${logPrefix} Audio capture stopped")
                }

                // Expose stop function globally for cleanup
                window.${stopFunctionName} = stopAudioCapture

                // Auto-cleanup on page unload
                window.addEventListener("beforeunload", () => {
                    stopAudioCapture()
                })

                // Notify all subscribers when a track is detected
                function notifyTrackSubscribers(track, receiver, pc) {
                    // Remember it for subscribers that are not here yet. A track
                    // that already ended, or one being announced a second time,
                    // is dropped here rather than passed on: replaying it would
                    // register the same diarization track twice.
                    const seen = window.__audioTrackLayer.seenTracks || (window.__audioTrackLayer.seenTracks = [])
                    if (track.readyState === "ended" || seen.some(entry => entry.track.id === track.id)) {
                        return
                    }
                    seen.push({ track: track, receiver: receiver, pc: pc })

                    // The backlog holds live media objects, so an entry lives only
                    // as long as its track: a call that renegotiates repeatedly
                    // would otherwise keep every track it ever had reachable and
                    // make each replay scan longer. Dropping the entry costs no
                    // deduplication — an ended track is refused above, and ended
                    // is terminal.
                    if (typeof track.addEventListener === "function") {
                        track.addEventListener("ended", () => {
                            const backlog = window.__audioTrackLayer.seenTracks || []
                            const index = backlog.findIndex(entry => entry.track === track)
                            if (index !== -1) {
                                backlog.splice(index, 1)
                            }
                        }, { once: true })
                    }

                    trackSubscribers.forEach(listener => {
                        try {
                            if (listener && typeof listener.onTrack === "function") {
                                listener.onTrack(track, receiver, pc)
                            }
                        } catch (e) {
                            console.error("${logPrefix} Error in track subscriber:", e)
                        }
                    })
                }

                // NetEq decoder tap. In roughly half of Meet sessions (server-side
                // experiment) audio never arrives as WebRTC tracks: it is decoded
                // by a "neteq-processor" AudioWorklet node and wired into a
                // MediaStreamAudioDestinationNode for playback. That destination
                // node exposes a real MediaStreamTrack — hand it to the same track
                // layer the WebRTC path uses, and the downstream frame pipeline
                // (activity detection, health checks) works unchanged. The tap
                // fires on connect(), so ordering between node and destination
                // creation does not matter, and notifyTrackSubscribers dedupes by
                // track id if Meet reconnects the graph.
                if (typeof window.AudioWorkletNode === "function") {
                    const OriginalAWN = window.AudioWorkletNode
                    const WrappedAWN = function (...args) {
                        const processorName = typeof args[1] === "string" ? args[1] : ""
                        const node = Reflect.construct(OriginalAWN, args, new.target || WrappedAWN)
                        if (processorName.toLowerCase().indexOf("neteq") !== -1) {
                            try {
                                const originalConnect = node.connect.bind(node)
                                node.connect = function (...connectArgs) {
                                    const result = originalConnect(...connectArgs)
                                    try {
                                        const dest = connectArgs[0]
                                        if (dest && dest.stream && typeof dest.stream.getAudioTracks === "function") {
                                            const tapped = dest.stream.getAudioTracks()[0]
                                            if (tapped) {
                                                console.log("${logPrefix} NetEq decoder output tapped: track " + tapped.id)
                                                notifyTrackSubscribers(tapped, null, null)
                                            }
                                        }
                                    } catch (tapError) {
                                        console.error("${logPrefix} NetEq tap error:", tapError)
                                    }
                                    return result
                                }
                            } catch (wrapError) {
                                console.error("${logPrefix} NetEq connect wrap failed:", wrapError)
                            }
                        }
                        return node
                    }
                    WrappedAWN.prototype = OriginalAWN.prototype
                    Object.setPrototypeOf(WrappedAWN, OriginalAWN)
                    window.AudioWorkletNode = WrappedAWN
                }

                // Intercept RTCPeerConnection to capture audio tracks
                if (typeof window.RTCPeerConnection !== "undefined") {
                    const OriginalPC = window.RTCPeerConnection
                    ${enablePeriodicScanning ? "const allPeerConnections = []" : ""}

                    window.RTCPeerConnection = function (...args) {
                        const pc = new OriginalPC(...args)
                        ${enablePeriodicScanning ? "allPeerConnections.push(pc)" : ""}

                        pc.addEventListener("track", (event) => {
                            if (event.track.kind === "audio") {
                                console.log("${logPrefix} Audio track detected:", event.track.id)

                                // Notify network interception subscribers (for diarization)
                                const receivers = pc.getReceivers()
                                const receiver = receivers.find(r => r.track === event.track)
                                if (receiver) {
                                    notifyTrackSubscribers(event.track, receiver, pc)
                                }
                            }
                        })
                        return pc
                    }

                    ${
                      enablePeriodicScanning
                        ? `
                    // Teams needs periodic scanning as connections may be created at different times
                    const scannedTracks = new Set()

                    let periodicScanIntervalId = null
                    const scanTimeoutIds = []

                    function scanForTracks() {
                        let foundTracks = 0
                        let newTracks = 0

                        allPeerConnections.forEach((pc, index) => {
                            try {
                                const receivers = pc.getReceivers()
                                receivers.forEach(receiver => {
                                    if (receiver.track && receiver.track.kind === "audio") {
                                        foundTracks++
                                        if (!scannedTracks.has(receiver.track.id)) {
                                            console.log("${logPrefix} Found audio track from PC[" + index + "]:", receiver.track.id)
                                            scannedTracks.add(receiver.track.id)
                                            newTracks++
                                        }
                                    }
                                })
                            } catch (e) {
                                console.error("${logPrefix} Error scanning PC[" + index + "]:", e)
                            }
                        })

                        if (newTracks > 0) {
                            console.log("${logPrefix} Scan: " + newTracks + " new tracks, " + foundTracks + " total")
                        }
                    }

                    function stopPeriodicScanning() {
                        if (periodicScanIntervalId !== null) {
                            clearInterval(periodicScanIntervalId)
                            periodicScanIntervalId = null
                        }
                        scanTimeoutIds.forEach(id => clearTimeout(id))
                        scanTimeoutIds.length = 0
                        console.log("${logPrefix} Periodic scanning stopped")
                    }

                    stopPeriodicScanningFn = stopPeriodicScanning

                    scanTimeoutIds.push(setTimeout(scanForTracks, 2000))
                    scanTimeoutIds.push(setTimeout(scanForTracks, 5000))
                    scanTimeoutIds.push(setTimeout(scanForTracks, 10000))
                    periodicScanIntervalId = setInterval(scanForTracks, 30000)
                    `
                        : ""
                    }

                    console.log("${logPrefix} RTCPeerConnection intercepted")
                }

                console.log("${logPrefix} Audio track layer initialized")
            } catch (e) {
                console.error("${logPrefix} Fatal Error:", e)
            }
        })();
    `
}

/**
 * Create audio capture functions for a specific provider
 */
export function createAudioCapture(config: AudioCaptureConfig) {
  const { logPrefix, stopFunctionName } = config

  return {
    /**
     * Enable audio track layer for this provider.
     * Creates __audioTrackLayer and intercepts RTCPeerConnection for diarization.
     * Audio streaming is handled by FFmpeg PulseAudio capture, not browser mixing.
     */
    enable: async (page: Page): Promise<void> => {
      const script = generateAudioCaptureScript(config)
      try {
        await page.addInitScript(script)
        console.log(`${logPrefix} Audio track layer script injected`)
      } catch (error) {
        console.error(`${logPrefix} Failed to inject script:`, formatError(error))
      }
    },

    /**
     * Stop audio capture gracefully
     */
    stop: async (page: Page): Promise<void> => {
      try {
        await page.evaluate((stopFn) => {
          const stopFunction = window[stopFn]
          if (typeof stopFunction === "function") {
            return stopFunction()
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
        const status = await page.evaluate(() => {
          return {
            hasAudioContext:
              typeof AudioContext !== "undefined" ||
              typeof window.webkitAudioContext !== "undefined"
          }
        })

        console.log(`${logPrefix} Status:`, status)

        if (!status.hasAudioContext) {
          console.error(`${logPrefix} AudioContext not available`)
          return false
        }

        console.log(`${logPrefix} Audio capture verified`)
        return true
      } catch (error) {
        console.error(`${logPrefix} Verification failed:`, formatError(error))
        return false
      }
    }
  }
}

// Pre-configured instances for Meet and Teams
export const meetAudioCapture = createAudioCapture(MEET_CONFIG)
export const teamsAudioCapture = createAudioCapture(TEAMS_CONFIG)
