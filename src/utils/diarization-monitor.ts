import {
  type DiarizationHealthStatus,
  type DiarizationHealthStatusLevel,
  DiarizationTracker
} from "../diarization-tracker"
import { sleep } from "./sleep"

/**
 * Monitor diarization health and log status.
 */
/**
 * Check diarization health with a delay to account for race conditions
 * between sound detection and segment updates.
 * @param meetingStartTime - Meeting start timestamp in milliseconds
 * @param currentTime - Current timestamp in milliseconds
 * @returns Health status object
 */
export async function checkDiarizationHealth(
  meetingStartTime: number,
  currentTime: number
): Promise<DiarizationHealthStatus> {
  // Add 100ms delay to account for race conditions between sound detection and segment updates
  await sleep(100)

  const tracker = DiarizationTracker.getInstance()
  return tracker.hasActiveOrRecentSegment(meetingStartTime, currentTime)
}

// Grace before the stale detector may retire the network path, per platform.
//
// Zoom: the roster doesn't arrive with the first signaling frames, and the fast
// threshold was retiring it ~8s after admission, before it could produce
// anything. The interceptor runs its own self-check at 45s.
//
// Teams: slower still. Per-participant audio levels are unavailable there (the
// interceptor's diag reports csrc levels of 0 throughout), so the only speaking
// signal is the dominant-speaker history on the data channel, which trickles in
// — observed still at its first entry fifteen seconds in and only at its third
// by ~90s. Retiring the path at ~10s hands the meeting to a UI observer that
// delivers speakers through an exposeFunction binding the page cannot always
// see under CloakBrowser, which is how Teams bots finished with an empty
// diarization.jsonl and a transcript full of "Speaker 1"/"Speaker 2".
//
// Meet: hiding createEncodedStreams flips Meet onto the native WebRTC path so getContributingSources()/CSRC finally
// reports per-participant tracks (source=audio). The first audio events land as
// (none)/"Unknown" during the initial roster race, so with a 0 dwell the
// neverProduced fast-fallback (~4s) retired the now-working native path before
// names resolved — observed live: 2/5 bots fast-retired mid roster-race. This
// floor gives the roster time to resolve. It is NOT applied unconditionally
// during neverProduced (that would reintroduce ~30s leading-"Unknown" heads on
// genuinely dead paths); the caller gates the neverProduced hold on a recent
// network-audio speaker event, so only a live-but-unresolved path is held.
const NETWORK_MIN_DWELL_MS: Record<string, number> = {
  zoom: 45_000,
  teams: 90_000,
  meet: 15_000
}

/**
 * How long the network diarization path is protected from the stale detector
 * after recording starts. 0 means it may be retired as soon as the stale
 * threshold is reached.
 * @param platform - Meeting platform ("meet" | "teams" | "zoom")
 */
export function networkMinDwellMs(platform: string): number {
  return NETWORK_MIN_DWELL_MS[platform] ?? 0
}

/**
 * Log health status with appropriate message.
 * @param status - Health status from diarization tracker
 */
export function logHealthStatus(status: DiarizationHealthStatus): void {
  if (status.status === "optimal") {
    console.log(`[DiarizationHealth] ✅ Optimal: ${status.segmentCount60s} segments in last 60s`)
  } else if (status.status === "acceptable") {
    console.log(
      `[DiarizationHealth] ⚠️ Acceptable: No segments in last 60s, but ${status.segmentCount5min} segment(s) in last 5min`
    )
  } else {
    console.log("[DiarizationHealth] ❌ Stale: No segments in last 5min despite sound activity")
  }
}

export type { DiarizationHealthStatus, DiarizationHealthStatusLevel }
