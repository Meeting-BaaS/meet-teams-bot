// Centralized audio-track layer for Google Meet network diarization.
//
// The Meet network-interception browser bundle handles the "main-channel"
// data channel only — track handling is centralized here. This installs
// window.__audioTrackLayer BEFORE navigation, proxying RTCPeerConnection so
// every audio track Meet negotiates is captured and replayed to the
// interceptor once it subscribes (post-admission). Without this layer the
// bundle sees tracks=0 forever and the network path never produces speakers.
//
// This is distinct from src/meeting/shared/audio-capture.ts, which is v1's
// Web-Audio streaming MIXER (only injected for streaming_output bots). The
// track layer is required for diarization on EVERY Meet bot, so it is injected
// unconditionally in openMeetingPage.
//
// Ported from Meeting-BaaS/meet-teams-bot v2-improvements
// (src/meeting/shared/audio-capture.ts, __audioTrackLayer).

import type { Page } from '@playwright/test'
import { formatError } from '../../utils/Logger'

const LOG_PREFIX = '[MeetAudioTrackLayer]'
const STOP_FN = '__meetAudioTrackLayerStop'

/**
 * Browser-side script (stringified, injected via addInitScript so it runs
 * before any Meet JS). Creates window.__audioTrackLayer and proxies
 * RTCPeerConnection to detect audio tracks. Subscribers (the network
 * interceptor) register via __audioTrackLayer.subscribe() and receive both
 * live tracks and a replay of any seen before they subscribed.
 */
function generateAudioTrackLayerScript(): string {
    return `
        (function() {
            try {
                // Idempotent init: reuse an existing layer if one is present.
                if (!window.__audioTrackLayer) {
                    console.log("${LOG_PREFIX} Initializing centralized audio track layer...")

                    window.__audioTrackLayer = {
                        subscribers: [],
                        // Tracks seen before anyone subscribed. This layer is
                        // installed before navigation, while the diarization
                        // interceptor only subscribes once the bot is admitted —
                        // so every track the call set up in between would be
                        // delivered to nobody. A late subscriber gets them now.
                        seenTracks: [],
                        subscribe: (callbacks) => {
                            window.__audioTrackLayer.subscribers.push(callbacks)
                            console.log("${LOG_PREFIX} Track subscriber registered")
                            const backlog = window.__audioTrackLayer.seenTracks || []
                            if (backlog.length && callbacks && typeof callbacks.onTrack === "function") {
                                console.log("${LOG_PREFIX} Replaying " + backlog.length + " already-detected track(s) to new subscriber")
                                backlog.forEach(entry => {
                                    if (entry.track.readyState === "ended") return
                                    try {
                                        callbacks.onTrack(entry.track, entry.receiver, entry.pc)
                                    } catch (e) {
                                        console.error("${LOG_PREFIX} Error replaying track to subscriber:", e)
                                    }
                                })
                            }
                        }
                    }
                } else if (window.__audioTrackLayer && !window.__audioTrackLayer.subscribers) {
                    window.__audioTrackLayer.subscribers = []
                    console.log("${LOG_PREFIX} Upgraded existing audio track layer with subscribers array")
                } else {
                    console.log("${LOG_PREFIX} Audio track layer already initialized, reusing existing instance")
                }

                const trackSubscribers = window.__audioTrackLayer.subscribers

                // Set when periodic scanning is armed, so stop can clear it.
                let stopPeriodicScanningFn = null

                function stopAudioTrackLayer() {
                    if (stopPeriodicScanningFn) stopPeriodicScanningFn()
                    // Nobody will subscribe again — drop the backlog rather than
                    // keep tracks, receivers and peer connections reachable.
                    if (window.__audioTrackLayer) {
                        window.__audioTrackLayer.seenTracks = []
                    }
                    console.log("${LOG_PREFIX} Audio track layer stopped")
                }
                window.${STOP_FN} = stopAudioTrackLayer
                window.addEventListener("beforeunload", () => stopAudioTrackLayer())

                function notifyTrackSubscribers(track, receiver, pc) {
                    // Remember it for subscribers that are not here yet. An ended
                    // track, or one announced a second time, is dropped: replaying
                    // it would register the same diarization track twice.
                    const seen = window.__audioTrackLayer.seenTracks || (window.__audioTrackLayer.seenTracks = [])
                    if (track.readyState === "ended" || seen.some(entry => entry.track.id === track.id)) {
                        return
                    }
                    seen.push({ track: track, receiver: receiver, pc: pc })

                    // The backlog holds live media objects, so an entry lives only
                    // as long as its track: a call that renegotiates repeatedly
                    // would otherwise keep every track it ever had reachable.
                    if (typeof track.addEventListener === "function") {
                        track.addEventListener("ended", () => {
                            const backlog = window.__audioTrackLayer.seenTracks || []
                            const index = backlog.findIndex(entry => entry.track === track)
                            if (index !== -1) backlog.splice(index, 1)
                        }, { once: true })
                    }

                    trackSubscribers.forEach(listener => {
                        try {
                            if (listener && typeof listener.onTrack === "function") {
                                listener.onTrack(track, receiver, pc)
                            }
                        } catch (e) {
                            console.error("${LOG_PREFIX} Error in track subscriber:", e)
                        }
                    })
                }

                // Proxy RTCPeerConnection to capture audio tracks. Meet's PC is
                // created after navigation, so wrapping the constructor here
                // (pre-goto) guarantees we see it before Meet grabs the original.
                if (typeof window.RTCPeerConnection !== "undefined") {
                    const OriginalPC = window.RTCPeerConnection
                    const allPeerConnections = []

                    window.RTCPeerConnection = function (...args) {
                        const pc = new OriginalPC(...args)
                        allPeerConnections.push(pc)

                        pc.addEventListener("track", (event) => {
                            if (event.track.kind === "audio") {
                                console.log("${LOG_PREFIX} Audio track detected:", event.track.id)
                                const receivers = pc.getReceivers()
                                const receiver = receivers.find(r => r.track === event.track)
                                if (receiver) {
                                    notifyTrackSubscribers(event.track, receiver, pc)
                                }
                            }
                        })
                        return pc
                    }

                    // Periodic getReceivers() sweep. The constructor 'track'
                    // event alone misses Meet's audio track on some sessions
                    // (observed live: 1 of 3 bots caught it, 2 saw tracks=0 with
                    // audio flowing). A sweep recovers a receiver.track that
                    // exists on the PC but whose 'track' event we never got —
                    // notifyTrackSubscribers dedups by track id, so re-finding an
                    // already-seen track is a no-op.
                    const scannedTracks = new Set()
                    let periodicScanIntervalId = null
                    const scanTimeoutIds = []

                    function scanForTracks() {
                        allPeerConnections.forEach((pc, index) => {
                            try {
                                pc.getReceivers().forEach(receiver => {
                                    if (receiver.track && receiver.track.kind === "audio") {
                                        if (!scannedTracks.has(receiver.track.id)) {
                                            console.log("${LOG_PREFIX} Found audio track from PC[" + index + "] via sweep:", receiver.track.id)
                                            scannedTracks.add(receiver.track.id)
                                            notifyTrackSubscribers(receiver.track, receiver, pc)
                                        }
                                    }
                                })
                            } catch (e) {
                                console.error("${LOG_PREFIX} Error scanning PC[" + index + "]:", e)
                            }
                        })
                    }

                    stopPeriodicScanningFn = function () {
                        if (periodicScanIntervalId !== null) {
                            clearInterval(periodicScanIntervalId)
                            periodicScanIntervalId = null
                        }
                        scanTimeoutIds.forEach(id => clearTimeout(id))
                        scanTimeoutIds.length = 0
                    }

                    scanTimeoutIds.push(setTimeout(scanForTracks, 2000))
                    scanTimeoutIds.push(setTimeout(scanForTracks, 5000))
                    scanTimeoutIds.push(setTimeout(scanForTracks, 10000))
                    periodicScanIntervalId = setInterval(scanForTracks, 15000)

                    console.log("${LOG_PREFIX} RTCPeerConnection intercepted (periodic sweep armed)")
                }

                console.log("${LOG_PREFIX} Audio track layer initialized")
            } catch (e) {
                console.error("${LOG_PREFIX} Fatal Error:", e)
            }
        })();
    `
}

/**
 * Inject the audio-track layer. MUST run before page.goto() — addInitScript
 * only applies to subsequent navigations. Non-fatal: on failure the network
 * interceptor sees no tracks and the in-call watchdog falls back to the UI
 * observer.
 */
export async function enableMeetAudioTrackLayer(page: Page): Promise<void> {
    try {
        await page.addInitScript(generateAudioTrackLayerScript())
        console.log(`${LOG_PREFIX} Audio track layer script injected`)
    } catch (error) {
        console.error(
            `${LOG_PREFIX} Failed to inject audio track layer:`,
            formatError(error),
        )
    }
}
